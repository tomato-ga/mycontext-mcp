import { describe, expect, it } from "vitest";
import {
  buildSearchQueryPlan,
  expandSynonyms,
  extractSearchTerms,
  normalizeSearchText,
  type PersonalSynonymConfig
} from "../src/searchQuery.js";
import { resolveEditorTrainingSearchIntent } from "../src/editorTrainingSearchIntent.js";
import { resolvePlaybookSearchIntent } from "../src/playbookSearchIntent.js";
import { resolveSkillContextSearchIntent } from "../src/skillContextSearchIntent.js";

// Entirely fictional stand-in for a PERSONAL_SYNONYMS secret, injected explicitly per test.
// No real names, revenue figures, or other personal facts belong in this file — see
// searchQuery.ts for how the real map is loaded from an env-provided secret at runtime.
const FICTIONAL_SYNONYMS: PersonalSynonymConfig = {
  termAliases: {
    "たろう": { aliases: ["山田太郎"], suppressOriginalTerm: true },
    "能力": { aliases: ["スキルマップ", "スキル"] },
    "事業": { aliases: ["起業", "経営"] },
    "会社経営": { aliases: ["経営", "起業"] },
    "考える": { aliases: ["考え"] },
    "検索": { aliases: ["SEO", "AEO"] },
    "生成AI": { aliases: ["AI"] },
    "Webメディア": { aliases: ["ウェブメディア"] }
  },
  synonymGroups: [
    ["たろう", "太郎", "山田太郎"],
    ["個人開発", "個人プロダクト", "一人開発"],
    ["AIエージェント", "AI agent", "エージェント"],
    ["収益化", "事業化", "マネタイズ", "収益"],
    ["月20万円", "20万円", "月20万"],
    ["編集", "編集者", "コンテンツ制作"],
    ["業務自動化", "自動化", "オートメーション"]
  ]
};

describe("natural-language search planning", () => {
  it("resolves media and editing playbook aliases to canonical whole-document IDs", () => {
    expect(resolvePlaybookSearchIntent("MCPこれのmedia playbook 読み込んでみて"))
      .toMatchObject({
        documentId: "editor-knowledge:knowhow-media-design",
        canonicalTitle: "メディア運営プレイブック"
      });
    expect(resolvePlaybookSearchIntent("MyContext Documents 編集プレイブックを読んで"))
      .toMatchObject({
        documentId: "editor-knowledge:henshu-editing-playbook",
        canonicalTitle: "MyContext Documents 編集プレイブック"
      });
    expect(resolvePlaybookSearchIntent("media playbookと編集プレイブックを比較して"))
      .toBeNull();
  });

  it("routes distinctive editor-training topics to canonical lesson documents", () => {
    expect(resolveEditorTrainingSearchIntent(
      "企画を検討する編集会議の進行方法を知りたい"
    )).toMatchObject({
      documentId: "editor-knowledge:lesson-06",
      canonicalTitle: "第6回: 編集会議"
    });
    expect(resolveEditorTrainingSearchIntent(
      "ウェブメディアの基本的な仕組みを編集者研修から説明して"
    )).toMatchObject({
      documentId: "editor-knowledge:lesson-01",
      canonicalTitle: "第1回: ウェブメディアの基礎知識"
    });
    expect(resolveEditorTrainingSearchIntent("編集の基本姿勢を知りたい")).toBeNull();
  });

  it("routes one exact analysis-skill ID without guessing a batch request", () => {
    expect(resolveSkillContextSearchIntent(
      "marketing-lean-canvas をMCPから読み込んで"
    )).toMatchObject({
      skillId: "marketing-lean-canvas",
      documentId: "skill-context:marketing-lean-canvas"
    });
    expect(resolveSkillContextSearchIntent(
      "marketing-lean-canvas と resolution-diagnose を比較して"
    )).toBeNull();
  });

  it("normalizes full-width characters and whitespace", () => {
    expect(normalizeSearchText("  ＡＩ   エージェント  ")).toBe("AI エージェント");
  });

  it("extracts bounded important terms from a long Japanese question", () => {
    const query =
      "たろうの個人開発・AIエージェント活用・月20万円の収益化目標に関する背景と強み";
    const terms = extractSearchTerms(query, FICTIONAL_SYNONYMS.termAliases);
    expect(terms).toHaveLength(8);
    expect(terms).toEqual(expect.arrayContaining([
      "山田太郎",
      "個人開発",
      "AIエージェント",
      "月20万円",
      "収益化",
      "背景",
      "強み"
    ]));
  });

  it("returns unexpanded, generic terms when no synonym config is injected (the safe default)", () => {
    const query = "たろうの個人開発・AIエージェント活用・月20万円の収益化目標に関する背景と強み";
    const terms = extractSearchTerms(query);
    // "たろう" is not resolved to any alias, and no term is dropped or suppressed
    expect(terms).toEqual(expect.arrayContaining(["たろう", "個人開発", "AIエージェント"]));
    expect(terms).not.toContain("山田太郎");
  });

  it("builds a separate synonym fallback without sending the query to an LLM", () => {
    expect(expandSynonyms(["たろう", "収益化"], FICTIONAL_SYNONYMS.synonymGroups)).toEqual([
      "太郎",
      "山田太郎",
      "事業化",
      "マネタイズ",
      "収益"
    ]);
    expect(buildSearchQueryPlan("個人開発について", FICTIONAL_SYNONYMS)).toEqual({
      phrase: "個人開発について",
      terms: ["個人開発"],
      synonymTerms: ["個人プロダクト", "一人開発"]
    });
  });

  it("expands nothing when no synonym groups are injected (the safe default)", () => {
    expect(expandSynonyms(["たろう", "収益化"])).toEqual([]);
    expect(buildSearchQueryPlan("個人開発について")).toEqual({
      phrase: "個人開発について",
      terms: ["個人開発"],
      synonymTerms: []
    });
  });

  it("drops generic request language", () => {
    expect(extractSearchTerms("教えて AIエージェントについて")).toEqual([
      "AIエージェント"
    ]);
  });

  it("uses locale-aware segmentation for Japanese clauses", () => {
    expect(extractSearchTerms("編集者に必要なスキルにはどんなものがある？", FICTIONAL_SYNONYMS.termAliases))
      .toEqual(expect.arrayContaining(["編集", "スキル"]));
    expect(extractSearchTerms(
      "編集とは何を考える仕事なのか、編集の基本姿勢を知りたい",
      FICTIONAL_SYNONYMS.termAliases
    )).toEqual(expect.arrayContaining(["編集", "考え", "基本姿勢"]));
    expect(extractSearchTerms(
      "Webメディアの基礎知識を新人編集者向けに教えて",
      FICTIONAL_SYNONYMS.termAliases
    )).toEqual(expect.arrayContaining(["Webメディア", "ウェブメディア"]));
  });

  it("keeps meaningful subterms from long Japanese compounds for title matching", () => {
    expect(extractSearchTerms("編集研修カリキュラム全体の構成をまとめて"))
      .toEqual(expect.arrayContaining(["編集", "研修", "カリキュラム", "全体"]));
    expect(extractSearchTerms("MVPからPMFまでの起業プロセス"))
      .toEqual(expect.arrayContaining(["MVP", "PMF", "起業"]));
    expect(extractSearchTerms("コンテンツマーケティングと生成AI時代の検索対策"))
      .toEqual(expect.arrayContaining(["コンテンツマーケティング", "マーケティング"]));
    expect(extractSearchTerms("技術やツールをスキルマップから確認したい"))
      .toEqual(expect.arrayContaining(["スキルマップ", "スキル"]));
  });
});
