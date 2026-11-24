import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerDir = fileURLToPath(new URL("..", import.meta.url));

describe("worker startup", () => {
  it("exits with a message naming the missing required variables", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: workerDir,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worker: Configuration error");
    expect(result.stderr).toContain("DATABASE_URL");
  });
});
