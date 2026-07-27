import type { SyncConfig } from "./config.js";
import {
  SyncFailure,
  type ManagedNotionDocument,
  type NotionGateway,
  type NotionMarkdown,
  type SyncCategory,
  type WorkflowStatus,
  type WorkflowUpdate
} from "./types.js";

const NOTION_VERSION = "2026-03-11";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export const NOTION_PROPERTIES = {
  name: "Name",
  documentId: "Document ID",
  category: "Category",
  status: "Status",
  active: "Active",
  schemaVersion: "Schema Version",
  lastSynced: "Last Synced",
  syncedHash: "Synced Hash",
  activeRevision: "Active Revision",
  tidbTables: "TiDB Tables",
  validationError: "Validation Error",
  syncSource: "Sync Source",
  originalPageId: "Original Page ID"
} as const;

const WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  "Draft",
  "Review",
  "Ready",
  "Syncing",
  "Synced",
  "Error",
  "Conflict",
  "Archived"
]);

const SYNC_CATEGORIES = new Set<SyncCategory>([
  "Personal Context",
  "AI Skill",
  "Author Style",
  "Editor Knowledge",
  "Metaskill"
]);

export class NotionApiClient implements NotionGateway {
  private readonly token: string;
  private readonly dataSourceId: string;
  private readonly fetcher: typeof fetch;

  constructor(config: Pick<SyncConfig, "notionApiToken" | "notionDataSourceId">, fetcher = fetch) {
    this.token = config.notionApiToken;
    this.dataSourceId = config.notionDataSourceId;
    this.fetcher = fetcher.bind(globalThis);
  }

  async getManagedDocument(pageId: string): Promise<ManagedNotionDocument> {
    const value = await this.request(`/v1/pages/${encodeURIComponent(pageId)}`);
    return parseManagedNotionDocument(value, this.dataSourceId);
  }

  async getMarkdown(pageId: string): Promise<NotionMarkdown> {
    const value = asRecord(
      await this.request(`/v1/pages/${encodeURIComponent(pageId)}/markdown`),
      "page markdown"
    );
    const markdown = requireString(value.markdown, "markdown");
    const unknown = value.unknown_block_ids;
    if (!Array.isArray(unknown) || unknown.some((item) => typeof item !== "string")) {
      throw new SyncFailure("notion_shape_invalid", "unknown_block_ids must be a string array");
    }
    return {
      markdown,
      truncated: requireBoolean(value.truncated, "truncated"),
      unknownBlockIds: unknown as string[]
    };
  }

  async updateWorkflow(pageId: string, update: WorkflowUpdate): Promise<void> {
    const properties: Record<string, unknown> = {
      [NOTION_PROPERTIES.status]: { status: { name: update.status } }
    };
    if (update.syncedHash !== undefined) {
      properties[NOTION_PROPERTIES.syncedHash] = richTextUpdate(update.syncedHash);
    }
    if (update.activeRevision !== undefined) {
      properties[NOTION_PROPERTIES.activeRevision] = richTextUpdate(update.activeRevision);
    }
    if (update.tidbTables !== undefined) {
      properties[NOTION_PROPERTIES.tidbTables] = {
        multi_select: update.tidbTables.map((name) => ({ name }))
      };
    }
    if (update.validationError !== undefined) {
      properties[NOTION_PROPERTIES.validationError] = richTextUpdate(
        update.validationError === null ? null : update.validationError.slice(0, 1800)
      );
    }
    if (update.lastSyncedAt !== undefined) {
      properties[NOTION_PROPERTIES.lastSynced] = {
        date: update.lastSyncedAt === null ? null : { start: update.lastSyncedAt }
      };
    }
    await this.request(`/v1/pages/${encodeURIComponent(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties })
    });
  }

  async findByDocumentId(documentId: string): Promise<ManagedNotionDocument[]> {
    return this.queryDocuments({
      property: NOTION_PROPERTIES.documentId,
      rich_text: { equals: documentId }
    });
  }

  private async queryDocuments(filter: Record<string, unknown>): Promise<ManagedNotionDocument[]> {
    const results: ManagedNotionDocument[] = [];
    let cursor: string | null = null;
    do {
      const value = asRecord(await this.request(
        `/v1/data_sources/${encodeURIComponent(this.dataSourceId)}/query`,
        {
          method: "POST",
          body: JSON.stringify({
            page_size: 100,
            filter,
            ...(cursor === null ? {} : { start_cursor: cursor })
          })
        }
      ), "data source query");
      if (!Array.isArray(value.results)) {
        throw new SyncFailure("notion_shape_invalid", "data source results must be an array");
      }
      for (const page of value.results) {
        results.push(parseManagedNotionDocument(page, this.dataSourceId));
      }
      cursor = value.has_more === true ? requireString(value.next_cursor, "next_cursor") : null;
    } while (cursor !== null);
    return results;
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.notion.com${pathname}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
          ...init.headers
        }
      });
    } catch (error) {
      throw new SyncFailure(
        "notion_request_failed",
        `Notion request failed: ${errorMessage(error)}`,
        { retryable: true }
      );
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new SyncFailure(
        "notion_api_failed",
        `Notion API ${response.status}: ${detail}`,
        { retryable: RETRYABLE_STATUS.has(response.status) }
      );
    }
    return response.json();
  }
}

export function parseManagedNotionDocument(
  value: unknown,
  expectedDataSourceId: string
): ManagedNotionDocument {
  const page = asRecord(value, "page");
  const parent = asRecord(page.parent, "parent");
  const actualDataSourceId = requireString(parent.data_source_id, "parent.data_source_id");
  if (normalizeId(actualDataSourceId) !== normalizeId(expectedDataSourceId)) {
    throw new SyncFailure(
      "notion_data_source_mismatch",
      "Notion page does not belong to the configured MyContext data source",
      { workflowStatus: "Conflict" }
    );
  }
  const properties = asRecord(page.properties, "properties");
  const statusValue = propertyName(properties, NOTION_PROPERTIES.status, "status");
  if (!WORKFLOW_STATUSES.has(statusValue as WorkflowStatus)) {
    throw new SyncFailure("notion_status_invalid", `Unsupported Status: ${statusValue}`);
  }
  const categoryValue = propertyName(properties, NOTION_PROPERTIES.category, "select");
  if (!SYNC_CATEGORIES.has(categoryValue as SyncCategory)) {
    throw new SyncFailure("notion_category_invalid", `Unsupported Category: ${categoryValue}`);
  }
  return {
    pageId: requireString(page.id, "page.id"),
    dataSourceId: actualDataSourceId,
    documentId: propertyText(properties, NOTION_PROPERTIES.documentId, "rich_text"),
    name: propertyText(properties, NOTION_PROPERTIES.name, "title"),
    category: categoryValue as SyncCategory,
    status: statusValue as WorkflowStatus,
    active: propertyCheckbox(properties, NOTION_PROPERTIES.active),
    schemaVersion: propertyName(properties, NOTION_PROPERTIES.schemaVersion, "select"),
    syncSource: propertyName(properties, NOTION_PROPERTIES.syncSource, "select"),
    originalPageId: propertyOptionalText(
      properties,
      NOTION_PROPERTIES.originalPageId,
      "rich_text"
    ),
    syncedHash: propertyOptionalText(properties, NOTION_PROPERTIES.syncedHash, "rich_text"),
    activeRevision: propertyOptionalText(
      properties,
      NOTION_PROPERTIES.activeRevision,
      "rich_text"
    ),
    lastEditedTime: requireString(page.last_edited_time, "last_edited_time")
  };
}

function propertyText(
  properties: Record<string, unknown>,
  name: string,
  expectedType: "title" | "rich_text"
): string {
  const value = propertyOptionalText(properties, name, expectedType);
  if (value === null || value.length === 0) {
    throw new SyncFailure("notion_property_missing", `${name} must not be empty`);
  }
  return value;
}

function propertyOptionalText(
  properties: Record<string, unknown>,
  name: string,
  expectedType: "title" | "rich_text"
): string | null {
  const property = getProperty(properties, name, expectedType);
  const items = property[expectedType];
  if (!Array.isArray(items)) {
    throw new SyncFailure("notion_property_invalid", `${name} must contain text items`);
  }
  const text = items.map((item) => {
    const record = asRecord(item, name);
    return typeof record.plain_text === "string" ? record.plain_text : "";
  }).join("").trim();
  return text.length === 0 ? null : text;
}

function propertyName(
  properties: Record<string, unknown>,
  name: string,
  expectedType: "select" | "status"
): string {
  const property = getProperty(properties, name, expectedType);
  const option = asRecord(property[expectedType], name);
  return requireString(option.name, `${name}.name`);
}

function propertyCheckbox(properties: Record<string, unknown>, name: string): boolean {
  const property = getProperty(properties, name, "checkbox");
  return requireBoolean(property.checkbox, name);
}

function getProperty(
  properties: Record<string, unknown>,
  name: string,
  expectedType: string
): Record<string, unknown> {
  const property = asRecord(properties[name], name);
  if (property.type !== expectedType) {
    throw new SyncFailure(
      "notion_property_invalid",
      `${name} must be a ${expectedType} property`
    );
  }
  return property;
}

function richTextUpdate(value: string | null): { rich_text: unknown[] } {
  return {
    rich_text: value === null || value.length === 0
      ? []
      : [{ type: "text", text: { content: value } }]
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncFailure("notion_shape_invalid", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyncFailure("notion_shape_invalid", `${name} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new SyncFailure("notion_shape_invalid", `${name} must be a boolean`);
  }
  return value;
}

function normalizeId(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
