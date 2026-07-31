import {
  EDITING_PLAYBOOK_DOCUMENT_ID,
  EDITING_PLAYBOOK_SOURCE_ID,
  buildEditingPlaybookResourceUri
} from "./editingPlaybook.js";
import {
  MEDIA_PLAYBOOK_DOCUMENT_ID,
  MEDIA_PLAYBOOK_SOURCE_ID,
  buildMediaPlaybookResourceUri
} from "./mediaPlaybook.js";
import { normalizeSearchText } from "./searchQuery.js";

export interface PlaybookSearchIntent {
  documentId: string;
  sourceId: string;
  canonicalTitle: string;
  resourceUri: string;
}

const PLAYBOOK_INTENTS: readonly (PlaybookSearchIntent & {
  compactAliases: readonly string[];
})[] = [
  {
    documentId: MEDIA_PLAYBOOK_DOCUMENT_ID,
    sourceId: MEDIA_PLAYBOOK_SOURCE_ID,
    canonicalTitle: "メディア運営プレイブック",
    resourceUri: buildMediaPlaybookResourceUri(),
    compactAliases: [
      "メディア運営プレイブック",
      "メディアプレイブック",
      "mediaplaybook",
      "knowhowmediadesign"
    ]
  },
  {
    documentId: EDITING_PLAYBOOK_DOCUMENT_ID,
    sourceId: EDITING_PLAYBOOK_SOURCE_ID,
    canonicalTitle: "MyContext Documents 編集プレイブック",
    resourceUri: buildEditingPlaybookResourceUri(),
    compactAliases: [
      "mycontextdocuments編集プレイブック",
      "編集プレイブック",
      "editingplaybook",
      "henshueditingplaybook"
    ]
  }
];

/**
 * Resolves explicit playbook names before generic keyword ranking.
 *
 * ChatGPT conversations can retain an older tools/list response, so a newly added dedicated
 * playbook tool is not guaranteed to be available in an existing conversation. Keeping this
 * routing inside the long-lived search_personal_context tool makes those conversations resolve
 * the same canonical, whole-document record without relying on a refreshed tool catalogue.
 */
export function resolvePlaybookSearchIntent(query: string): PlaybookSearchIntent | null {
  const compactQuery = normalizeSearchText(query)
    .toLocaleLowerCase("ja")
    .replace(/[\s　_-]+/gu, "");
  const matches = PLAYBOOK_INTENTS.filter((intent) =>
    intent.compactAliases.some((alias) => compactQuery.includes(alias))
  );
  if (matches.length !== 1) {
    return null;
  }
  const { compactAliases: _compactAliases, ...intent } = matches[0];
  return intent;
}
