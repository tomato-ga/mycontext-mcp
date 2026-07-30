import path from "node:path";
import { createTidbClientFromEnv } from "../tidb.js";
import { toAppError, type CliFlags } from "../types.js";

export async function runFinalizeAuthorStyleCurrent(_flags: CliFlags): Promise<void> {
  const client = createTidbClientFromEnv();
  try {
    const statements = await client.applySchema(
      path.resolve("author-style-current-cleanup.sql")
    );
    console.log(JSON.stringify({
      status: "ok",
      scope: "author_style_history_cleanup",
      statements
    }, null, 2));
  } catch (error) {
    throw toAppError(
      error,
      "finalize_author_style_current_failed",
      "author style history cleanup failed",
      3
    );
  } finally {
    await client.close();
  }
}
