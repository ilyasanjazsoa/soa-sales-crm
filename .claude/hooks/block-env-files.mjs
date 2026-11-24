#!/usr/bin/env node
// PreToolUse hook: blocks Claude from reading or editing .env files (CLAUDE.md rule 8:
// "Never commit secrets. Do not read .env."). .env.example is allowed.
// Exit code 2 blocks the tool call and shows the message to Claude. Anything unexpected fails closed.
import { basename } from "node:path";

const block = (what) => {
  process.stderr.write(
    `Blocked by project hook: ${what} touches a .env file. Claude must not read or edit .env files ` +
      "(CLAUDE.md rule 8). Edit .env.example instead, or ask the user to change their .env.\n",
  );
  process.exit(2);
};

// macOS file systems are case-insensitive, so compare in lower case.
const isProtectedPath = (path) => {
  const name = basename(path).toLowerCase();
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
};

/* Shell commands: strip quoting and escapes (so `.e''nv` and `.e\nv` collapse), lower-case, remove the
   allowed spellings, then refuse anything that still names a .env file or could expand to one through a glob
   or brace expansion (`.env*`, `.en?`, `{.env,x}`, `.[e]nv`). */
const ALLOWED_IN_COMMANDS = [/\.env\.example\b/g, /process\.env\b/g, /import\.meta\.env\b/g, /\$env:/g];
const ENV_LIKE =
  /\.e(?:nv|n[?*[]|[?*[])|\.[?*[]nv|\.\[[^\]]*e[^\]]*\]nv|\.e\[[^\]]*n[^\]]*\]v|(?:^|[\s/=])\.[*?](?:$|[\s;|&])/;

const commandTouchesEnv = (command) => {
  let text = command.toLowerCase().replace(/["'`\\]/g, "");
  for (const allowed of ALLOWED_IN_COMMANDS) text = text.replace(allowed, "");
  if (ENV_LIKE.test(text)) return true;
  // Brace expansion such as {.env,x} or .{env,x}
  return /\{[^}]*\.?env[^}]*\}/.test(text) && /\.\{|\{\./.test(text);
};

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  block("an unreadable tool call");
}
if (input === null || typeof input !== "object") block("an unreadable tool call");

const tool = typeof input.tool_name === "string" ? input.tool_name : "";
const args = input.tool_input !== null && typeof input.tool_input === "object" ? input.tool_input : {};

if (tool === "Bash") {
  if (commandTouchesEnv(String(args.command ?? ""))) block("this shell command");
} else {
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof args[key] === "string" && isProtectedPath(args[key])) block(`${tool} on ${basename(args[key])}`);
  }
  // Glob patterns (the Glob tool's pattern, Grep's glob filter) that would match .env files
  const globs = [tool === "Glob" ? args.pattern : undefined, args.glob].filter((value) => typeof value === "string");
  for (const glob of globs) {
    if (/(^|[/{,])\.(env|e[*?[]|[*?[])/i.test(glob) && !/\.env\.example$/i.test(glob)) block(`${tool} with ${glob}`);
  }
}
process.exit(0);
