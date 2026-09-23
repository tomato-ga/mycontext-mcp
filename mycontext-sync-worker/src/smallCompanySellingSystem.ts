import {
  assertStorageLimits,
  assertUniqueSectionIds,
  splitContentLines,
  type BusinessKnowledgeContentLayer,
  type BusinessKnowledgeSection,
  type LoadedBusinessKnowledgeDocument
} from "../../mycontext-sync/src/businessKnowledge.js";
import { sha256 } from "./hash.js";
import { hasNonFencedH1 } from "./markdown.js";
import { SyncFailure } from "./types.js";

export const SMALL_COMPANY_SELLING_SYSTEM_DOCUMENT_ID =
  "small-company-selling-system" as const;
export const SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1 =
  "# 小さな会社の売れる仕組み — 高精度文字起こし";
export const SMALL_COMPANY_SELLING_SYSTEM_PARSER_VERSION =
  "book-transcription-parser-v1";
export const SMALL_COMPANY_SELLING_SYSTEM_SECTIONING_VERSION =
  "toc-anchor-sectioning-v1";
export const SMALL_COMPANY_SELLING_SYSTEM_ORIGIN_SHA256 =
  "ba32518e196fe631b3a142f5767995083903e5a61a44268ad834884caf94ac20";

const MAX_DELIVERY_CHARS = 12_000;

type FreshnessClass = "static_framework" | "dated_example" | "time_sensitive";

interface AnchorDefinition {
  sectionId: string;
  title: string;
  markers: readonly string[];
  parentSectionId: string | null;
  chapterTitle: string | null;
  headingLevel: number | null;
  sectionNumber: string | null;
  contentLayer: BusinessKnowledgeContentLayer;
  isSearchable: boolean;
  freshnessClass: FreshnessClass;
}

interface LocatedAnchor {
  definition: AnchorDefinition;
  lineIndex: number;
}

function chapter(
  sectionId: string,
  sectionNumber: string,
  title: string,
  markers: readonly string[],
  freshnessClass: FreshnessClass = "static_framework"
): AnchorDefinition {
  return {
    sectionId,
    title,
    markers,
    parentSectionId: null,
    chapterTitle: title,
    headingLevel: 2,
    sectionNumber,
    contentLayer: "summary",
    isSearchable: true,
    freshnessClass
  };
}

function detail(
  sectionId: string,
  title: string,
  marker: string,
  parentSectionId: string,
  chapterTitle: string,
  freshnessClass: FreshnessClass = "static_framework"
): AnchorDefinition {
  return {
    sectionId,
    title,
    markers: [marker],
    parentSectionId,
    chapterTitle,
    headingLevel: 3,
    sectionNumber: null,
    contentLayer: "detail",
    isSearchable: true,
    freshnessClass
  };
}

function summary(
  sectionId: string,
  title: string,
  marker: string,
  parentSectionId: string,
  chapterTitle: string,
  freshnessClass: FreshnessClass = "static_framework"
): AnchorDefinition {
  return {
    ...detail(sectionId, title, marker, parentSectionId, chapterTitle, freshnessClass),
    contentLayer: "summary"
  };
}

function indexSection(
  sectionId: string,
  title: string,
  markers: readonly string[]
): AnchorDefinition {
  return {
    sectionId,
    title,
    markers,
    parentSectionId: null,
    chapterTitle: null,
    headingLevel: null,
    sectionNumber: null,
    contentLayer: "index",
    isSearchable: false,
    freshnessClass: "static_framework"
  };
}

const CHAPTER_1 = "第1章 「仕組み」の全体像と3つのルール";
const CHAPTER_2 = "第2章 戦わずに勝つ市場弱者の戦略";
const CHAPTER_3 = "第3章 世界一やさしいフレームワーク「戦略5原則」";
const CHAPTER_4 = "第4章 「戦略5原則」の実践";
const CHAPTER_5 = "第5章 売り込まずに売れる商品の作り方";
const CHAPTER_6 = "第6章 マインドフローで整える集客の流れ";
const CHAPTER_7 = "第7章 マーケティングとブランディングの関係性";
const CHAPTER_8 = "第8章 事例でわかる小さな会社の売れる仕組み";

const ANCHORS: readonly AnchorDefinition[] = [
  indexSection("front-matter", "前付・目次", [SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1]),

  chapter("chapter-01", "1", CHAPTER_1, ["第1章", "「仕組み」の全体像と", "3つのルール"]),
  detail("chapter-01-basics", "マーケティング戦略思考の基礎は小学生でもわかる", "マーケティング戦略思考の基礎は小学生でもわかる", "chapter-01", CHAPTER_1),
  detail("chapter-01-three-rules", "全業種共通！売れる仕組みを構成する3つのルール", "全業種共通!売れる仕組みを構成する「3つのルール」", "chapter-01", CHAPTER_1),
  detail("chapter-01-two-points", "売れる仕組みで失敗しないための2つの重要ポイント", "売れる仕組みで失敗しないための2つの重要ポイント", "chapter-01", CHAPTER_1),
  summary("chapter-01-summary", "第1章まとめ", "まとめ第1章コレだけはおさえておこう!", "chapter-01", CHAPTER_1),

  chapter("chapter-02", "2", CHAPTER_2, ["第2章", "ルール1", "「戦略設計]", "戦わずに勝つ", "市場弱者の戦略"]),
  detail("chapter-02-strategy-first", "市場弱者のマーケティングは戦略が9割", "市場弱者のマーケティングは戦略が9割", "chapter-02", CHAPTER_2),
  detail("chapter-02-comparison", "強制的に比べられて知らない間に負ける", "強制的に比べられて知らない間に負ける", "chapter-02", CHAPTER_2),
  detail("chapter-02-no-strategy", "戦略なきマーケティング活動とは？", "戦略なきマーケティング活動とは?", "chapter-02", CHAPTER_2),
  detail("chapter-02-five-disadvantages", "戦略なきマーケティングの5つのデメリット", "戦略なきマーケティングの5つのデメリット", "chapter-02", CHAPTER_2),
  detail("chapter-02-focus", "戦略とは努力の選択と集中", "戦略とは努力の選択と集中", "chapter-02", CHAPTER_2),
  detail("chapter-02-three-elements", "3つの要素の特定で小さな市場のトップになる", "「3つの要素」の特定で小さな市場のトップになる", "chapter-02", CHAPTER_2),
  detail("chapter-02-customer-view", "お題目ではなく本当のお客様目線で", "お題目ではなく本当のお客様目線で", "chapter-02", CHAPTER_2),
  detail("chapter-02-strategic-activity", "戦略的なマーケティング活動", "戦略的なマーケティング活動", "chapter-02", CHAPTER_2),
  detail("chapter-02-expand-market", "戦略的に小さく勝って市場を広げる", "戦略的に小さく勝って市場を広げる", "chapter-02", CHAPTER_2),
  detail("chapter-02-stp", "王道のSTP分析とは？", "王道の「STP分析」とは?", "chapter-02", CHAPTER_2),
  summary("chapter-02-summary", "第2章まとめ", "まとめ第2章コレだけはおさえておこう!", "chapter-02", CHAPTER_2),

  chapter("chapter-03", "3", CHAPTER_3, ["第章", "世界一やさしいフレーム", "ワーク「戦略5原則」"]),
  detail("chapter-03-principles", "戦略5原則の基本概念", "戦略5原則の基本概念の説明", "chapter-03", CHAPTER_3),
  detail("chapter-03-three-cafes", "同じ立地・規模の3つの店舗型カフェ", "同じような立地・規模の3つの店舗型カフェ", "chapter-03", CHAPTER_3),
  detail("chapter-03-cafe-a", "A店の戦略5原則", "A店の戦略5原則", "chapter-03", CHAPTER_3),
  detail("chapter-03-cafe-b", "B店の戦略5原則", "B店の戦略5原則", "chapter-03", CHAPTER_3),
  detail("chapter-03-consistency", "3つの特定が一貫性を持ったときトップになる", "「3つの特定」が「一貫性」を持ったとき勝手にトップになる", "chapter-03", CHAPTER_3),
  detail("chapter-03-no-special-strength", "特別な強みや圧倒的な差別化はなくても勝てる理由", "特別な強みや圧倒的な差別化はなくても勝てる理由", "chapter-03", CHAPTER_3),
  detail("chapter-03-ttp-risk", "TTPの危険性", "TTPの危険性|強みは不変的なものではない", "chapter-03", CHAPTER_3),
  detail("chapter-03-elements-together", "ターゲット・ニーズ・強みはセットで考える", "「ターゲット」「ニーズ」「強み」個別に考えると失敗する", "chapter-03", CHAPTER_3),
  detail("chapter-03-simple-thinking", "無機質なフレームワークで難しく考えるほど失敗しやすい", "無機質なフレームワークで難しく考えるほど失敗しやすい", "chapter-03", CHAPTER_3),
  summary("chapter-03-summary", "第3章まとめ", "まとめ第3章コレだけおさえておこう!", "chapter-03", CHAPTER_3),

  chapter("chapter-04", "4", CHAPTER_4, [":4.", "「戦略5原則」の実", "強みが見つかる5つの質問"]),
  detail("chapter-04-start", "戦略5原則をやってみよう", "戦略5原則をやってみよう", "chapter-04", CHAPTER_4),
  detail("chapter-04-thirty-points", "最初は30点でOK", "最初は30点でOK!", "chapter-04", CHAPTER_4),
  detail("chapter-04-plain-words", "整ったキレイな言葉にしない", "整ったキレイな言葉にしない", "chapter-04", CHAPTER_4),
  detail("chapter-04-principle-1", "原則1 ターゲットの考え方", "原則1ターゲットの考え方のヒント", "chapter-04", CHAPTER_4),
  detail("chapter-04-no-happy-customer", "喜んでくれたお客様がまだいない場合", "まだ喜んでくれたお客様がいない場合は?", "chapter-04", CHAPTER_4),
  detail("chapter-04-principle-2", "原則2 お客様の目的・ニーズ", "原則2お客様の目的(ニーズ)の考え方のヒント", "chapter-04", CHAPTER_4),
  detail("chapter-04-constraints", "ニーズを具体化する制限・条件", "ニーズを具体化する「制限・条件」", "chapter-04", CHAPTER_4),
  detail("chapter-04-what-shop", "お客様から見てあなたは何屋さんか", "-☆お客様から見て、あなたは何屋さん?", "chapter-04", CHAPTER_4),
  detail("chapter-04-principle-3", "原則3 お客様の別の選択肢・競合", "-原則3、お客様の別の選択肢(競合)の考え方のヒント", "chapter-04", CHAPTER_4),
  detail("chapter-04-principle-4", "原則4 お客様が選ぶ理由・強み", "-原則4お客様が選ぶ理由(強み)の考え方のヒント", "chapter-04", CHAPTER_4),
  detail("chapter-04-selling-strength", "売れない強みと売れる強み", "売れない強みと売れる強み", "chapter-04", CHAPTER_4),
  detail("chapter-04-strength-missing", "強みが見つからない最大の理由", "強みが見つからない最大の理由", "chapter-04", CHAPTER_4),
  detail("chapter-04-loop", "戦略5原則はグルグル回す", "戦略5原則はグルグル回す。ピラティス教室の事例", "chapter-04", CHAPTER_4),
  detail("chapter-04-second-loop", "2周目に独自の経験を書き込む", "2周目独自の経験を書き込んでみる", "chapter-04", CHAPTER_4),
  detail("chapter-04-do-not-think-alone", "そもそも自分で考えるから失敗する", "そもそも自分で考えるから失敗する", "chapter-04", CHAPTER_4),

  chapter("chapter-05", "5", CHAPTER_5, ["第5章", "ルール2", "「商品設計」", "売り込まずに売れる", "商品の作り方"]),
  detail("chapter-05-three-roles", "商品の役割を3つに分ける", "商品の役割を3つに分ける", "chapter-05", CHAPTER_5),
  detail("chapter-05-common-model", "どんな業種でも商品設計の考え方は共通", "どんな業種でも商品設計の考え方は共通", "chapter-05", CHAPTER_5),
  detail("chapter-05-three-errors", "商品設計の3つのよくある間違い", "商品設計の3つのよくある間違い", "chapter-05", CHAPTER_5),
  detail("chapter-05-profit-model", "薄利多売と厚利少売", "薄利多売のモデルと厚利少売のモデル", "chapter-05", CHAPTER_5),
  detail("chapter-05-practice", "戦略5原則に基づく商品設計", "戦略5原則に基づいて商品設計をやってみよう", "chapter-05", CHAPTER_5),
  detail("chapter-05-free-product", "無料だからこそ良い商品を作る", "無料だからこそ良い商品を作る", "chapter-05", CHAPTER_5),
  detail("chapter-05-ideas", "商品設計のアイデアが湧かない場合", "商品設計のアイデアが湧かない場合の対処法!", "chapter-05", CHAPTER_5),

  chapter("chapter-06", "6", CHAPTER_6, ["第 / 章", "ルール3", "「集客設計」", "マインドフローで整える", "集客の流れ"]),
  detail("chapter-06-seven-gates", "マインドフローの7つの関門", "マインドフローの7つの関門", "chapter-06", CHAPTER_6),
  detail("chapter-06-product-relation", "集客設計と商品設計の関係性", "集客設計と商品設計との関係性", "chapter-06", CHAPTER_6),
  detail("chapter-06-web-and-real", "ウェブ集客とリアル集客の流れ", "王道的なウェブ集客とリアル集客の流れの構造", "chapter-06", CHAPTER_6),
  detail("chapter-06-multiple-flows", "集客の流れは複数本ある", "集客の流れは1本ではなく複数本ある", "chapter-06", CHAPTER_6),
  detail("chapter-06-demonstration", "集客課題を見つけるデモンストレーション", "集客課題を見つけるデモンストレーション", "chapter-06", CHAPTER_6),
  detail("chapter-06-expectation-and-anxiety", "期待を大きくするより不安を取り除く", "期待を大きくするより不安を取り除く", "chapter-06", CHAPTER_6),
  detail("chapter-06-preempt-reasons", "買わない理由を先回りして対策する", "お客様が買わない理由を先回りして対策する", "chapter-06", CHAPTER_6),
  detail("chapter-06-easy-countermeasures", "不安や疑問の対策は簡単にできる", "不安や疑問の対策は簡単にできることが多い", "chapter-06", CHAPTER_6),
  detail("chapter-06-customer-story", "お客様の物語の中で改善する", "お客様の物語の中で改善しなければ意味がない", "chapter-06", CHAPTER_6),
  detail("chapter-06-reference", "参考情報", "参考情報", "chapter-06", CHAPTER_6),
  summary("chapter-06-summary", "第6章まとめ", "まとめ第6章コレだけはおさえておこう!", "chapter-06", CHAPTER_6),

  chapter("chapter-07", "7", CHAPTER_7, ["ブフ:", "マーケティングと", "ブランディングの関係性"]),
  detail("chapter-07-three-rules", "3つのルールと売れる仕組み", "3つのルールと売れる仕組みの組み立て方", "chapter-07", CHAPTER_7),
  detail("chapter-07-strategy-summary", "ルール1総括 戦略設計", "ルール]総括戦略設計", "chapter-07", CHAPTER_7),
  detail("chapter-07-product-summary", "ルール2総括 商品設計", "ルール2総括商品設計", "chapter-07", CHAPTER_7),
  detail("chapter-07-attraction-summary", "ルール3総括 集客設計", "ルール3総括集客設計", "chapter-07", CHAPTER_7),
  detail("chapter-07-wheelchair-salon", "車いす専門の美容室", "「車いす専門の美容室」のデモンストレーション", "chapter-07", CHAPTER_7),
  detail("chapter-07-branding", "マーケティングの役割の1つがブランディング", "マーケティングの役割の1つがブランディング", "chapter-07", CHAPTER_7),
  detail("chapter-07-marketing-overview", "一番広いマーケティングの全体像", "一番広いマーケティングの全体像", "chapter-07", CHAPTER_7),
  detail("chapter-07-web-digital", "ウェブマーケティングとデジタルマーケティング", "ウェブマーケティングとデジタルマーケティング", "chapter-07", CHAPTER_7),
  detail("chapter-07-kotler", "コトラーの王道理論と同じプロセス", "コトラーの王道理論と同じプロセス", "chapter-07", CHAPTER_7),
  detail("chapter-07-small-company", "大企業と個人・中小企業の決定的な違い", "大企業と個人・中小企業の決定的な違い", "chapter-07", CHAPTER_7),
  summary("chapter-07-summary", "第7章まとめ", "まとめ第7章コレだけはおさえておこう!", "chapter-07", CHAPTER_7),

  chapter("chapter-08", "8", CHAPTER_8, ["第8", "事例でわかる", "「小さな会社の", "売れる仕組み」"], "dated_example"),
  detail("chapter-08-health-food", "事例1 健康食品会社", "https://www.kodama-kenko.jp/", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-health-food-target", "価値を伝えるのが難しい商品のターゲット設定", "価値を伝えるのが難しい商品のターゲット設定", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-all4", "事例2 個別指導塾オール4", "https://all-for.jp/", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-all4-mismatch", "コンセプトと集客設計の食い違い", "コンセプトと集客設計の食い違い", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-lwf", "事例3 LWF自宅教室経営スクール", "https://school.lifewithflowers.net/", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-lwf-principles", "LWF自宅教室経営スクールの戦略5原則", "「LWF自宅教室経営スクール」さんの戦略5原則", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-lwf-target", "ターゲット以外のお客様はお断り？", "ターゲット以外のお客様はお断り?", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-bodylabo", "事例4 BodyLaboらくなり", "https://bodylabo-rakunari.com/", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-bodylabo-target", "事業全体と商品単位のターゲット設定", "事業全体と商品単位のターゲット設定", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-law-office", "事例5 法律事務所の採用マーケティング", "法律事務所戦略的採用マーケティングで即戦力を0円採用", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-law-office-principles", "法律事務所の採用版戦略5原則", "A法律事務所の採用版戦略5原則", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-law-office-hiring", "ピンポイントで即戦力を0円採用", "ピンポイントで即戦力を0円採用", "chapter-08", CHAPTER_8, "dated_example"),
  detail("chapter-08-law-office-outcome", "求人難でも最良の人材に出会える", "求人難でも集客戦略を使って最良の人材に出会える", "chapter-08", CHAPTER_8, "dated_example"),

  indexSection("acknowledgements", "謝辞", ["謝辞"]),
  indexSection("author-profile", "著者プロフィール", ["著者プロフィール"]),
  indexSection("publisher", "奥付", ["小さな会社の売れる仕組み"]),
  indexSection("kindle-ui", "Kindle末尾情報", ["＜禁止事項＞"])
];

export interface SmallCompanySellingSystemInput {
  title: string;
  markdown: string;
  sourcePathKey: string;
  sourceMtimeMs: number;
}

export function canonicalSmallCompanySellingSystemMarkdown(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (normalized.startsWith(`${SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1}\n`)) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }
  if (hasNonFencedH1(normalized)) {
    throw new SyncFailure(
      "business_knowledge_unexpected_h1",
      "Business Knowledge body contains an unexpected H1"
    );
  }
  const body = normalized.replace(/^\n+/, "").replace(/\n+$/, "");
  return `${SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1}\n\n${body}\n`;
}

export function parseSmallCompanySellingSystemMarkdown(
  input: SmallCompanySellingSystemInput
): LoadedBusinessKnowledgeDocument {
  const markdown = canonicalSmallCompanySellingSystemMarkdown(input.markdown);
  const lines = splitContentLines(markdown);
  const located = locateAnchors(lines);
  const markdownSha256 = sha256(markdown);
  const sectionRevisionSha256 = sha256(
    `${markdownSha256}\0${SMALL_COMPANY_SELLING_SYSTEM_PARSER_VERSION}\0${SMALL_COMPANY_SELLING_SYSTEM_SECTIONING_VERSION}`
  );
  const sections: BusinessKnowledgeSection[] = located.map((anchor, index) => {
    const start = anchor.lineIndex;
    const endExclusive = located[index + 1]?.lineIndex ?? lines.length;
    const sectionMarkdown = lines.slice(start, endExclusive).join("\n").trimEnd();
    if (sectionMarkdown.length > MAX_DELIVERY_CHARS) {
      throw new SyncFailure(
        "business_knowledge_delivery_too_large",
        `${anchor.definition.sectionId} is ${sectionMarkdown.length} characters; maximum is ${MAX_DELIVERY_CHARS}`
      );
    }
    const headingPath = anchor.definition.chapterTitle === null
      ? [input.title, anchor.definition.title]
      : anchor.definition.parentSectionId === null
        ? [input.title, anchor.definition.title]
        : [input.title, anchor.definition.chapterTitle, anchor.definition.title];
    return {
      documentId: SMALL_COMPANY_SELLING_SYSTEM_DOCUMENT_ID,
      sectionId: anchor.definition.sectionId,
      sectionRevisionSha256,
      parentSectionId: anchor.definition.parentSectionId,
      deliverySectionId: anchor.definition.sectionId,
      sectionType: "numbered_section",
      headingLevel: anchor.definition.headingLevel,
      sectionNumber: anchor.definition.sectionNumber,
      title: anchor.definition.title,
      headingPath,
      contentLayer: anchor.definition.contentLayer,
      ordinal: index + 1,
      sourceLineStart: start + 1,
      sourceLineEnd: endExclusive,
      directMarkdown: sectionMarkdown,
      sectionMarkdown,
      retrievalText: `${headingPath.join(" > ")}\n${sectionMarkdown}`,
      contentSha256: sha256(sectionMarkdown),
      isSearchable: anchor.definition.isSearchable,
      relatedSourcePath: null,
      freshnessClass: anchor.definition.freshnessClass
    };
  });

  assertUniqueSectionIds(sections);
  assertStorageLimits(markdown, sections);
  const searchSpanCount = sections.filter((section) => section.isSearchable).length;
  return {
    documentId: SMALL_COMPANY_SELLING_SYSTEM_DOCUMENT_ID,
    title: input.title,
    sourcePathKey: input.sourcePathKey,
    sourceKind: "book_transcription",
    ingestScope: "full_text",
    sourceDeclaredAt: "2024-10-23",
    sourceBytes: new TextEncoder().encode(markdown).byteLength,
    sourceLineCount: lines.length,
    sourceMtimeMs: input.sourceMtimeMs,
    markdown,
    markdownSha256,
    sectionRevisionSha256,
    parserVersion: SMALL_COMPANY_SELLING_SYSTEM_PARSER_VERSION,
    sectioningVersion: SMALL_COMPANY_SELLING_SYSTEM_SECTIONING_VERSION,
    sectionCount: sections.length,
    searchSpanCount,
    outline: {
      chapters: [
        { key: "chapter-01", number: 1, title: CHAPTER_1 },
        { key: "chapter-02", number: 2, title: CHAPTER_2 },
        { key: "chapter-03", number: 3, title: CHAPTER_3 },
        { key: "chapter-04", number: 4, title: CHAPTER_4 },
        { key: "chapter-05", number: 5, title: CHAPTER_5 },
        { key: "chapter-06", number: 6, title: CHAPTER_6 },
        { key: "chapter-07", number: 7, title: CHAPTER_7 },
        { key: "chapter-08", number: 8, title: CHAPTER_8 }
      ],
      sectionKeys: sections.map((section) => section.sectionId)
    },
    routingMetadata: {
      defaultRetrieval: "small_to_big",
      matchedChildExpandsTo: "delivery_section_id",
      detailAvailable: true,
      sourceFormat: "ocr_transcription",
      originSourcePathKey:
        "private-exports/kindle-books/小さな会社の売れる仕組み/text/小さな会社の売れる仕組み_文字起こし_高精度.md",
      originMarkdownSha256: SMALL_COMPANY_SELLING_SYSTEM_ORIGIN_SHA256
    },
    sections
  };
}

function locateAnchors(lines: readonly string[]): LocatedAnchor[] {
  const located: LocatedAnchor[] = [];
  const comparisonLines = lines.map(normalizeAnchorComparisonLine);
  let cursor = 0;
  for (const definition of ANCHORS) {
    const matches: number[] = [];
    for (
      let lineIndex = cursor;
      lineIndex <= comparisonLines.length - definition.markers.length;
      lineIndex += 1
    ) {
      if (definition.markers.every(
        (marker, offset) => comparisonLines[lineIndex + offset] === marker
      )) {
        matches.push(lineIndex);
      }
    }
    if (matches.length !== 1) {
      throw new SyncFailure(
        "business_knowledge_anchor_contract_mismatch",
        `${definition.sectionId} expected exactly one ordered marker, got ${matches.length}`
      );
    }
    const lineIndex = matches[0];
    located.push({ definition, lineIndex });
    cursor = lineIndex + definition.markers.length;
  }
  return located;
}

function normalizeAnchorComparisonLine(value: string): string {
  return value
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      (full, label: string, url: string) => label === url ? label : full
    )
    .replace(/\\([\\*~`$\[\]<>\{\}|^])/g, "$1");
}
