import { z } from "zod";

const MAX_SEARCH_TERMS = 8;
const JAPANESE_WORD_SEGMENTER = new Intl.Segmenter("ja-JP", {
  granularity: "word"
});

const REQUEST_PREFIXES = [
  "教えて",
  "知りたい",
  "調べて",
  "探して",
  "確認して",
  "まとめて",
  "説明して"
];

const REQUEST_SUFFIXES = [
  "について",
  "に関する",
  "に関して",
  "を教えて",
  "を知りたい",
  "を調べて",
  "を探して",
  "とは何か",
  "とは"
];

const COMPOUND_SUFFIXES = [
  "チェックリスト",
  "チェックポイント",
  "づくり",
  "活用",
  "利用",
  "一覧",
  "時代",
  "対策",
  "目標",
  "経験",
  "実績",
  "背景",
  "強み",
  "弱み",
  "理由",
  "方針",
  "方法",
  "仕事",
  "構想",
  "役割",
  "者"
];

const QUERY_STOP_WORDS = new Set([
  "こと",
  "もの",
  "ため",
  "これ",
  "それ",
  "どれ",
  "情報",
  "内容",
  "詳細",
  "関連",
  "関係",
  "教えて",
  "知りたい",
  "調べて",
  "探して",
  "確認して",
  "まとめて",
  "説明して",
  "活用",
  "利用",
  "一覧",
  "時代",
  "対策",
  "仕事",
  "構想",
  "どんな",
  "ある",
  "何",
  "本人",
  "含めて",
  "含む",
  "必要",
  "する",
  "教え",
  "知",
  "たい",
  "探",
  "確認",
  "に関する",
  "について",
  "どんなもの"
]);

/**
 * The curated term-alias/synonym-group data itself (names, revenue figures, and other
 * personally-tuned vocabulary) is never hardcoded in this file — it is loaded at runtime from
 * the optional PERSONAL_SYNONYMS secret (see config.ts / parsePersonalSynonymConfig below) and
 * threaded through as plain function arguments, defaulting to EMPTY_PERSONAL_SYNONYM_CONFIG
 * everywhere. With no secret configured, search still works; it just performs no personal
 * synonym expansion.
 */
export interface TermAliasEntry {
  aliases: readonly string[];
  /**
   * When true and aliases are present, the original matched term itself is dropped from the
   * expansion and only its aliases are kept (e.g. a short nickname resolving to a full,
   * unambiguous name). Defaults to false: both the term and its aliases are kept.
   */
  suppressOriginalTerm?: boolean;
}

export type TermAliasMap = Readonly<Record<string, TermAliasEntry>>;
export type SynonymGroups = readonly (readonly string[])[];

export interface PersonalSynonymConfig {
  termAliases: TermAliasMap;
  synonymGroups: SynonymGroups;
}

export const EMPTY_PERSONAL_SYNONYM_CONFIG: PersonalSynonymConfig = {
  termAliases: {},
  synonymGroups: []
};

const termAliasEntrySchema = z.object({
  aliases: z.array(z.string().min(1)).min(1),
  suppressOriginalTerm: z.boolean().optional()
});

const personalSynonymConfigSchema = z.object({
  termAliases: z.record(z.string(), termAliasEntrySchema).default({}),
  synonymGroups: z.array(z.array(z.string().min(1)).min(2)).default([])
});

/**
 * Parses the PERSONAL_SYNONYMS secret (a JSON string) into a PersonalSynonymConfig. Missing,
 * blank, or malformed input safely falls back to EMPTY_PERSONAL_SYNONYM_CONFIG (logging a
 * warning if a value was present but invalid) rather than throwing — a misconfigured optional
 * secret must never break search.
 *
 * Expected shape:
 * {
 *   "termAliases": {
 *     "<term>": { "aliases": ["<alias>", ...], "suppressOriginalTerm": false }
 *   },
 *   "synonymGroups": [["<term>", "<synonym>", ...], ...]
 * }
 */
export function parsePersonalSynonymConfig(raw: string | undefined): PersonalSynonymConfig {
  if (raw === undefined || raw.trim().length === 0) {
    return EMPTY_PERSONAL_SYNONYM_CONFIG;
  }
  try {
    const parsed = personalSynonymConfigSchema.parse(JSON.parse(raw));
    return {
      termAliases: parsed.termAliases,
      synonymGroups: parsed.synonymGroups
    };
  } catch {
    console.warn("personal_synonyms_config_invalid");
    return EMPTY_PERSONAL_SYNONYM_CONFIG;
  }
}

export interface SearchQueryPlan {
  phrase: string;
  terms: string[];
  synonymTerms: string[];
}

export function buildSearchQueryPlan(
  query: string,
  config: PersonalSynonymConfig = EMPTY_PERSONAL_SYNONYM_CONFIG
): SearchQueryPlan {
  const phrase = normalizeSearchText(query);
  const terms = extractSearchTerms(phrase, config.termAliases);
  return {
    phrase,
    terms,
    synonymTerms: expandSynonyms(terms, config.synonymGroups)
  };
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function extractSearchTerms(
  query: string,
  termAliases: TermAliasMap = {}
): string[] {
  let working = normalizeSearchText(query);
  for (const prefix of REQUEST_PREFIXES) {
    if (working.startsWith(prefix)) {
      working = working.slice(prefix.length).trim();
    }
  }
  for (const suffix of REQUEST_SUFFIXES) {
    if (working.endsWith(suffix)) {
      working = working.slice(0, -suffix.length).trim();
    }
  }

  const coarseParts = working
    .split(/[\s　・、。,.!?！？:：;；/／|｜()[\]{}「」『』【】〈〉《》]+/u)
    .flatMap(splitJapaneseConnectors)
    .map(cleanTerm)
    .filter(isUsefulTerm);

  const expanded: string[] = [];
  for (const part of coarseParts) {
    for (const term of deriveTerms(part)) {
      const entry = termAliases[term];
      const aliases = entry?.aliases ?? [];
      if (entry?.suppressOriginalTerm === true && aliases.length > 0) {
        expanded.push(...aliases);
      } else {
        expanded.push(term, ...aliases);
      }
    }
  }
  for (const part of segmentJapaneseWords(working)) {
    if (expanded.some((term) =>
      term !== part &&
      term.includes(part) &&
      !/[ぁ-ん]/u.test(term) &&
      (
        term.length - part.length <= 2 ||
        /^[A-Za-z0-9]+$/u.test(part)
      )
    )) {
      continue;
    }
    expanded.push(part, ...(termAliases[part]?.aliases ?? []));
  }

  return rankTerms(uniqueTerms(expanded), termAliases).slice(0, MAX_SEARCH_TERMS);
}

export function expandSynonyms(
  terms: string[],
  synonymGroups: SynonymGroups = []
): string[] {
  const expanded: string[] = [];
  for (const term of terms) {
    const normalizedTerm = term.toLocaleLowerCase("ja");
    const group = synonymGroups.find((candidate) =>
      candidate.some((value) => value.toLocaleLowerCase("ja") === normalizedTerm)
    );
    if (group === undefined) continue;
    for (const synonym of group) {
      if (synonym.toLocaleLowerCase("ja") !== normalizedTerm) {
        expanded.push(synonym);
      }
    }
  }
  return uniqueTerms(expanded).slice(0, MAX_SEARCH_TERMS);
}

function splitJapaneseConnectors(value: string): string[] {
  return value.split(
    /(?:について|に関する|に関して|という|として|する|して|した|から|まで|より|ので|の|を|が|は|へ|で|と|や|も)+/u
  );
}

function cleanTerm(value: string): string {
  return value
    .replace(/^[\-—–~〜]+|[\-—–~〜]+$/gu, "")
    .trim();
}

function isUsefulTerm(value: string): boolean {
  if (value.length < 2 || QUERY_STOP_WORDS.has(value)) return false;
  if (/^\d+$/u.test(value)) return false;
  return true;
}

function splitCompoundSuffix(value: string): { base: string; suffix: string } | null {
  for (const suffix of COMPOUND_SUFFIXES) {
    if (!value.endsWith(suffix)) continue;
    const base = value.slice(0, -suffix.length);
    if (base.length >= 2) {
      return { base, suffix };
    }
  }
  return null;
}

function deriveTerms(value: string): string[] {
  let normalized = value;
  for (const prefix of ["保有", "必要な"]) {
    if (normalized.startsWith(prefix) && normalized.length - prefix.length >= 2) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  const compound = splitCompoundSuffix(normalized);
  if (compound === null) return [normalized];
  return [compound.base, compound.suffix];
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeSearchText(value);
    const key = normalized.toLocaleLowerCase("ja");
    if (!isUsefulTerm(normalized) || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function segmentJapaneseWords(value: string): string[] {
  return Array.from(JAPANESE_WORD_SEGMENTER.segment(value))
    .filter((segment) => segment.isWordLike)
    .map((segment) => cleanTerm(segment.segment))
    .filter(isUsefulTerm);
}

function rankTerms(terms: string[], termAliases: TermAliasMap): string[] {
  return terms
    .map((term, index) => ({ term, index, score: termScore(term, termAliases) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ term }) => term);
}

function termScore(term: string, termAliases: TermAliasMap): number {
  let score = Math.min(term.length, 8);
  if (/[A-Za-z0-9]/u.test(term)) score += 2;
  if (termAliases[term] !== undefined) score += 1;
  return score;
}
