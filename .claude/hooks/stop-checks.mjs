#!/usr/bin/env node
// Stop hook: runs `pnpm typecheck && pnpm lint` before Claude finishes a turn.
// On failure it exits 2 so Claude sees the errors and keeps working. If the hook already
// sent Claude back once (stop_hook_active), it reports but lets Claude stop, to avoid a loop.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try {
  input = JSON.parse(raw);
} catch {
  // No usable input: still run the checks.
}

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
if (!existsSync(join(root, "node_modules"))) process.exit(0); // nothing installed yet

const run = spawnSync("pnpm typecheck && pnpm lint", { cwd: root, shell: true, encoding: "utf8" });
if (run.status === 0) process.exit(0);

const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-80).join("\n");
process.stderr.write(`pnpm typecheck && pnpm lint failed:\n${output}\n`);
process.exit(input.stop_hook_active ? 1 : 2);
