import { describe, expect, it } from "vitest";
import {
  TIDB_TABLES_BY_CATEGORY,
  tidbTablesForDocument
} from "../src/tidbTables.js";

describe("TiDB table routing metadata", () => {
  it("covers every supported Notion category with the actual read-model tables", () => {
    expect(TIDB_TABLES_BY_CATEGORY).toEqual({
      "Personal Context": ["notion_pages"],
      "AI Skill": ["notion_pages"],
      "Author Style": [
        "author_style_documents",
        "author_style_current_sections"
      ],
      "Editor Knowledge": [
        "editor_knowledge_documents",
        "editor_knowledge_sections"
      ],
      "Metaskill": [
        "metaskill_documents",
        "metaskill_revisions",
        "metaskill_sections"
      ]
    });
  });

  it("uses Schema Version as the source of truth for the table list", () => {
    expect(tidbTablesForDocument({
      documentId: "kikaku-composition-playbook",
      category: "Editor Knowledge",
      schemaVersion: "editor-knowledge-v1"
    })).toEqual([
      "editor_knowledge_documents",
      "editor_knowledge_sections"
    ]);
  });

  it("reports only the one-record table for compact playbooks", () => {
    for (const documentId of ["knowhow-media-design", "henshu-editing-playbook"]) {
      expect(tidbTablesForDocument({
        documentId,
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      })).toEqual(["editor_knowledge_documents"]);
    }
  });

  it("keeps table metadata truthful when an existing Category and Schema Version disagree", () => {
    expect(tidbTablesForDocument({
      documentId: "kikaku-composition-playbook",
      category: "Editor Knowledge",
      schemaVersion: "personal-context-v1"
    })).toEqual(["notion_pages"]);
  });

  it("falls back to Category for an unknown future Schema Version", () => {
    expect(tidbTablesForDocument({
      documentId: "ore-body-style",
      category: "Author Style",
      schemaVersion: "author-style-v2"
    })).toEqual([
      "author_style_documents",
      "author_style_current_sections"
    ]);
  });
});
