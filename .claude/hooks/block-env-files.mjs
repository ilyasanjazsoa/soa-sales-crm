#!/usr/bin/env node
// PreToolUse hook: blocks Claude from editing (or, through the shell, touching) .env files.
// .env.example is allowed. CLAUDE.md rule 8: "Never commit secrets. Do not read .env."
// Exit code 2 blocks the tool call and shows the message to Claude.
import { basename } from "node:path";

const isProtected = (path) => {
  const name = basename(path);
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
};

// A token that is a path ending in .env or .env.<suffix>, e.g. `.env`, `../../.env`, `$DIR/.env.local`.
const ENV_IN_COMMAND = /(?:^|[\s'"`=<>|;&()])((?:[\w./~${}-]*\/)?\.env(?:\.[\w.-]+)?)(?=$|[\s'"`;|&)<>])/g;

const block = (what) => {
  process.stderr.write(
    `Blocked by project hook: ${what} touches a .env file. Claude must not read or edit .env files ` +
      "(CLAUDE.md rule 8). Edit .env.example instead, or ask the user to change their .env.\n",
  );
  process.exit(2);
};

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  block("an unreadable tool call"); // fail closed
}

const tool = input.tool_name ?? "";
const args = input.tool_input ?? {};

if (tool === "Bash") {
  const command = String(args.command ?? "");
  for (const match of command.matchAll(ENV_IN_COMMAND)) {
    if (isProtected(match[1])) block(`the command \`${match[1]}\``);
  }
} else {
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof args[key] === "string" && isProtected(args[key])) block(`${tool} on ${basename(args[key])}`);
  }
}
process.exit(0);
