import path from "node:path";
import { createTidbClientFromEnv } from "../tidb.js";
import { toAppError, type CliFlags } from "../types.js";

export async function runTransitionAuthorStyleCurrent(_flags: CliFlags): Promise<void> {
  const client = createTidbClientFromEnv();
  try {
    const statements = await client.applySchema(
      path.resolve("author-style-current-transition.sql")
    );
    console.log(JSON.stringify({
      status: "ok",
      scope: "author_style_current_snapshot_transition",
      statements
    }, null, 2));
  } catch (error) {
    throw toAppError(
      error,
      "transition_author_style_current_failed",
      "author style current-snapshot transition failed",
      3
    );
  } finally {
    await client.close();
  }
}
