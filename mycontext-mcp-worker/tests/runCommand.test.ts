import { describe, expect, it } from "vitest";
import { runCommand } from "../scripts/release.mjs";

describe("release command output", () => {
  it("captures all stdout when a descendant outlives the command process", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e",
        "setTimeout(() => process.stdout.write('complete output'), 100)"
      ], { stdio: ["ignore", 1, "ignore"] });
      child.unref();
    `;

    const result = await runCommand(process.execPath, ["-e", script], {
      captureStdout: true
    });

    expect(result.stdout).toBe("complete output");
  });

  it("still rejects unsuccessful commands after their output closes", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.exitCode = 7"], {
      captureStdout: true
    })).rejects.toThrow("with exit code 7");
  });
});
