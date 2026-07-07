import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMirrorConfig } from "../src/config.js";

describe("config", () => {
  afterEach(() => {
    delete process.env.MIRROR_CONFIG_JSON;
  });

  it("loads valid page-only config", async () => {
    const configPath = await writeConfig({
      pages: [{ pageId: "page-1", title: "Profile" }]
    });

    const config = await loadMirrorConfig(configPath);
    expect(config.pages[0]).toMatchObject({
      pageId: "page-1",
      title: "Profile"
    });
  });

  it("rejects duplicate page ids", async () => {
    const configPath = await writeConfig({
      pages: [
        { pageId: "page-1", title: "Profile" },
        { pageId: "page-1", title: "Profile 2" }
      ]
    });

    await expect(loadMirrorConfig(configPath)).rejects.toMatchObject({ code: "duplicate_page_id" });
  });

  it("loads config from MIRROR_CONFIG_JSON", async () => {
    process.env.MIRROR_CONFIG_JSON = JSON.stringify({
      pages: [{ pageId: "page-from-env", title: "Env Profile" }]
    });

    const config = await loadMirrorConfig("missing-config-file.json");
    expect(config.pages[0]).toMatchObject({
      pageId: "page-from-env",
      title: "Env Profile"
    });
  });
});

async function writeConfig(value: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notion-context-config-"));
  const configPath = path.join(dir, "mirror.config.json");
  await fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return configPath;
}
