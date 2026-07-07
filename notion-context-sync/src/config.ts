import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AppError, type MirrorConfig } from "./types.js";

const pageSchema = z.object({
  pageId: z.string().min(1),
  title: z.string().min(1)
});

const mirrorConfigSchema = z.object({
  pages: z.array(pageSchema).min(1)
});

export async function loadMirrorConfig(configPath: string): Promise<MirrorConfig> {
  const absolutePath = path.resolve(configPath);
  const envConfig = optionalEnv("MIRROR_CONFIG_JSON");
  if (envConfig !== undefined) {
    return parseMirrorConfig(envConfig, "MIRROR_CONFIG_JSON");
  }

  let raw: string;
  try {
    raw = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    throw new AppError("config_read_failed", `failed to read config: ${absolutePath}`, 3, error);
  }

  return parseMirrorConfig(raw, absolutePath);
}

function parseMirrorConfig(raw: string, sourceName: string): MirrorConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError("config_json_invalid", `config is not valid JSON: ${sourceName}`, 3, error);
  }

  const parsed = mirrorConfigSchema.safeParse(decoded);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new AppError("config_invalid", details, 3);
  }

  const pageIds = new Set<string>();
  for (const page of parsed.data.pages) {
    if (pageIds.has(page.pageId)) {
      throw new AppError("duplicate_page_id", `duplicate pageId in config: ${page.pageId}`, 3);
    }
    pageIds.add(page.pageId);
  }

  return parsed.data;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError("missing_env", `missing required env var: ${name}`, 3);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function envBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return value.toLowerCase() === "true";
}

export function envNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError("invalid_env", `${name} must be a positive integer`, 3);
  }
  return parsed;
}
