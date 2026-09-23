import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SMALL_COMPANY_SELLING_SYSTEM_ORIGIN_SHA256,
  SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1,
  canonicalSmallCompanySellingSystemMarkdown,
  parseSmallCompanySellingSystemMarkdown
} from "../src/smallCompanySellingSystem.js";

const productionSourcePath = path.resolve(
  process.cwd(),
  "../private-exports/kindle-books/小さな会社の売れる仕組み/text/小さな会社の売れる仕組み_文字起こし_高精度.md"
);

describe("small-company-selling-system parser", () => {
  it("restores the source H1 that lives in the Notion Name/property boundary", () => {
    expect(canonicalSmallCompanySellingSystemMarkdown("本文")).toBe(
      `${SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1}\n\n本文\n`
    );
  });

  it("does not treat an H1-shaped line inside a code fence as a page title", () => {
    const body = [
      "```markdown",
      "# This is code, not the page title",
      "```",
      "本文"
    ].join("\n");

    expect(canonicalSmallCompanySellingSystemMarkdown(body)).toBe(
      `${SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1}\n\n${body}\n`
    );
  });

  it("keeps rejecting a real body H1 while respecting fence length and closure text", () => {
    const fencedBody = [
      "````markdown",
      "# This is code, not the page title",
      "```",
      "# This is still code",
      "```` not a closing fence",
      "# This is still code too",
      "````   ",
      "本文"
    ].join("\n");
    expect(canonicalSmallCompanySellingSystemMarkdown(fencedBody)).toBe(
      `${SMALL_COMPANY_SELLING_SYSTEM_SOURCE_H1}\n\n${fencedBody}\n`
    );

    expect(() => canonicalSmallCompanySellingSystemMarkdown("導入\n\n# 本文の実H1"))
      .toThrow("Business Knowledge body contains an unexpected H1");
  });

  it.runIf(fs.existsSync(productionSourcePath))(
    "parses the production transcription with the frozen semantic-section contract",
    () => {
      const markdown = fs.readFileSync(productionSourcePath, "utf8");
      const document = parseSmallCompanySellingSystemMarkdown({
        title: "小さな会社の売れる仕組み",
        markdown,
        sourcePathKey: "notion:parser-test",
        sourceMtimeMs: 0
      });

      expect(document.markdownSha256).toBe(SMALL_COMPANY_SELLING_SYSTEM_ORIGIN_SHA256);
      expect(document.sourceBytes).toBe(314_337);
      expect(document.sourceLineCount).toBe(3_824);
      expect(document.sectionCount).toBe(95);
      expect(document.searchSpanCount).toBe(90);
      expect(Math.max(...document.sections.map((section) => section.sectionMarkdown.length)))
        .toBeLessThanOrEqual(12_000);
      expect(document.sections.at(0)?.sectionId).toBe("front-matter");
      expect(document.sections.at(-1)?.sectionId).toBe("kindle-ui");
    }
  );
});
