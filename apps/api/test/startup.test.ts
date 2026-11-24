import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testEnv } from "./helpers";

const apiDir = fileURLToPath(new URL("..", import.meta.url));

describe("api startup", () => {
  it("exits with a message naming a missing required variable", () => {
    const env: Record<string, string> = { ...testEnv(), PATH: process.env.PATH ?? "" };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: apiDir,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing required variable(s): DATABASE_URL");
    expect(result.stderr).not.toContain(env.SESSION_SECRET);
  });
});
