import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/cloudflareWorkersStub.ts", import.meta.url)
      )
    }
  },
  test: {
    server: {
      deps: {
        inline: ["@cloudflare/workers-oauth-provider"]
      }
    }
  }
});
