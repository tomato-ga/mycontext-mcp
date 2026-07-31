import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PERSONAL_SYNONYM_CONFIG,
  parsePersonalSynonymConfig
} from "../src/searchQuery.js";

describe("parsePersonalSynonymConfig", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns the safe empty default when the secret is unset", () => {
    expect(parsePersonalSynonymConfig(undefined)).toEqual(EMPTY_PERSONAL_SYNONYM_CONFIG);
  });

  it("returns the safe empty default when the secret is blank", () => {
    expect(parsePersonalSynonymConfig("")).toEqual(EMPTY_PERSONAL_SYNONYM_CONFIG);
    expect(parsePersonalSynonymConfig("   \n")).toEqual(EMPTY_PERSONAL_SYNONYM_CONFIG);
  });

  it("parses a well-formed config", () => {
    const raw = JSON.stringify({
      termAliases: {
        "たろう": { aliases: ["山田太郎"], suppressOriginalTerm: true }
      },
      synonymGroups: [["個人開発", "個人プロダクト"]]
    });

    expect(parsePersonalSynonymConfig(raw)).toEqual({
      termAliases: {
        "たろう": { aliases: ["山田太郎"], suppressOriginalTerm: true }
      },
      synonymGroups: [["個人開発", "個人プロダクト"]]
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to empty and warns, rather than throwing, on invalid JSON", () => {
    expect(parsePersonalSynonymConfig("{not valid json")).toEqual(EMPTY_PERSONAL_SYNONYM_CONFIG);
    expect(warnSpy).toHaveBeenCalledWith(
      "personal_synonyms_config_invalid",
      expect.any(String)
    );
  });

  it("falls back to empty and warns, rather than throwing, when the shape does not match", () => {
    expect(parsePersonalSynonymConfig(JSON.stringify({ termAliases: "not-an-object" })))
      .toEqual(EMPTY_PERSONAL_SYNONYM_CONFIG);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("defaults missing top-level keys to empty collections", () => {
    expect(parsePersonalSynonymConfig("{}")).toEqual(EMPTY_PERSONAL_SYNONYM_CONFIG);
  });
});
