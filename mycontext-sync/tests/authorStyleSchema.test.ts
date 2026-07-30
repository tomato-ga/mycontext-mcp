import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("author style schema", () => {
  it("uses only current document and section snapshots", async () => {
    const sql = await fs.readFile(new URL("../author-style-schema.sql", import.meta.url), "utf8");

    expect(sql.match(/CREATE TABLE IF NOT EXISTS author_style_/g)).toHaveLength(2);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS author_style_documents");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS author_style_current_sections");
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS author_style_revisions");
    expect(sql).toContain("PRIMARY KEY (document_id, section_id)");
    expect(sql).toContain("context_sha256 CHAR(64)");
    expect(sql).toContain("routing_manifest_json JSON NOT NULL");
    expect(sql).toContain("delivery_markdown MEDIUMTEXT NOT NULL");
    expect(sql).not.toContain("business_knowledge_");
    expect(sql).not.toContain("editor_knowledge_");
    expect(sql).not.toContain("notion_pages");
  });
});
