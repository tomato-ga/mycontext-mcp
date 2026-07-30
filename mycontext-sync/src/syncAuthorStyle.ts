import {
  loadAuthorStyleDocument,
  type AuthorStyleSource,
  type LoadedAuthorStyleDocument
} from "./authorStyle.js";
import { AppError, type PageSyncStatus } from "./types.js";

export interface AuthorStyleWriter {
  getAuthorStyleDocumentState(documentId: string): Promise<{
    contextSha256: string;
    sourcePathKey: string;
  } | null>;
  upsertAuthorStyleDocumentAndSections(document: LoadedAuthorStyleDocument): Promise<void>;
}

export interface AuthorStyleSyncResult {
  documentId: string;
  displayName: string | null;
  status: PageSyncStatus;
  sourceMarkdownSha256: string;
  revisionSha256: string;
  sectionCount: number;
  deliverySectionCount: number;
  searchSpanCount: number;
  dbIndexed: boolean;
  warnings: string[];
}

export async function syncAuthorStyleDocument(options: {
  sourceRoot: string;
  source: AuthorStyleSource;
  tidbClient: AuthorStyleWriter | null;
  dryRun: boolean;
  reindex: boolean;
}): Promise<AuthorStyleSyncResult> {
  const document = await loadAuthorStyleDocument(options.sourceRoot, options.source);
  let dbIndexed = false;
  let dbSkipped = false;

  if (!options.dryRun) {
    if (options.tidbClient === null) {
      throw new AppError("tidb_client_missing", "TiDB client is required", 3);
    }
    const state = await options.tidbClient.getAuthorStyleDocumentState(
      document.documentId
    );
    if (state?.sourcePathKey.startsWith("notion:")) {
      throw new AppError(
        "author_style_source_owned_by_notion",
        `${document.documentId} is managed by Notion and cannot be overwritten from local Markdown`,
        3
      );
    }
    const currentContext = state?.contextSha256 ?? null;
    dbSkipped = !options.reindex && currentContext === document.revisionSha256;
    if (!dbSkipped) {
      await options.tidbClient.upsertAuthorStyleDocumentAndSections(document);
      dbIndexed = true;
    }
  }

  return {
    documentId: document.documentId,
    displayName: document.displayName,
    status: options.dryRun ? "dry_run" : dbSkipped ? "skipped" : "synced",
    sourceMarkdownSha256: document.sourceMarkdownSha256,
    revisionSha256: document.revisionSha256,
    sectionCount: document.sectionCount,
    deliverySectionCount: document.deliverySectionCount,
    searchSpanCount: document.searchSpanCount,
    dbIndexed,
    warnings: []
  };
}
