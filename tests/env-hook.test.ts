import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hook = fileURLToPath(new URL("../.claude/hooks/block-env-files.mjs", import.meta.url));

const run = (payload: unknown) =>
  spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: "utf8" }).status;

describe("PreToolUse .env hook", () => {
  it.each([
    ["Write", { file_path: "/repo/.env" }],
    ["Edit", { file_path: "/repo/.env.local" }],
    ["MultiEdit", { file_path: "apps/api/.env.production" }],
    ["Bash", { command: "echo SECRET=1 >> .env" }],
    ["Bash", { command: "cat ../../.env" }],
    ["Bash", { command: "sed -i '' 's/a/b/' $CLAUDE_PROJECT_DIR/.env" }],
    ["Bash", { command: "node --env-file=.env x.js" }],
    ["Write", { file_path: "/repo/.ENV" }],
    ["Read", { file_path: "/repo/apps/api/.Env.local" }],
    ["Bash", { command: "cat .ENV" }],
    ["Bash", { command: "cat .env*" }],
    ["Bash", { command: "cat .en?" }],
    ["Bash", { command: "cat {.env,x}" }],
    ["Bash", { command: "cat .env," }],
    ["Bash", { command: "cat ./.env:" }],
    ["Bash", { command: "cat .env#" }],
    ["Bash", { command: "cat .e''nv" }],
    ["Bash", { command: "cat .[e]nv" }],
    ["Bash", { command: "cat .*" }],
    ["Bash", { command: "ls .envrc" }],
    ["Glob", { pattern: "**/.env*" }],
    ["Grep", { pattern: "SECRET", glob: ".env*" }],
  ])("blocks %s %j", (tool_name, tool_input) => {
    expect(run({ tool_name, tool_input })).toBe(2);
  });

  it.each([
    ["Write", { file_path: "/repo/.env.example" }],
    ["Edit", { file_path: "/repo/apps/api/src/env.ts" }],
    ["Bash", { command: "cp .env.example /tmp/x && pnpm env:init" }],
    ["Bash", { command: "grep -r process.env apps" }],
    ["Bash", { command: "find . -name '*.ts' && ls -la" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Grep", { pattern: "import.meta.env", glob: "*.tsx" }],
    ["Read", { file_path: "/repo/docs/ENVIRONMENT.md" }],
  ])("allows %s %j", (tool_name, tool_input) => {
    expect(run({ tool_name, tool_input })).toBe(0);
  });

  it.each(["not json", "null", "42"])("fails closed on unreadable input %s", (input) => {
    const status = spawnSync(process.execPath, [hook], { input, encoding: "utf8" }).status;
    expect(status).toBe(2);
  });
});
