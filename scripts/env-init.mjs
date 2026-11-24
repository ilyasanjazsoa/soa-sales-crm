#!/usr/bin/env node
// Creates the local .env from .env.example and fills the blank secrets with random values.
// It never overwrites an existing .env and never prints secret values.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = `${root}.env`;
const SECRETS = new Set(["SESSION_SECRET", "TOKEN_ENC_KEY", "UNSUBSCRIBE_SECRET", "IP_HASH_SALT"]);

if (existsSync(target)) {
  console.log(".env already exists; leaving it unchanged.");
  process.exit(0);
}

const lines = readFileSync(`${root}.env.example`, "utf8").split("\n");
const filled = lines.map((line) => {
  const match = /^([A-Z0-9_]+)=$/.exec(line);
  return match && SECRETS.has(match[1]) ? `${match[1]}=${randomBytes(32).toString("hex")}` : line;
});
writeFileSync(target, filled.join("\n"), { mode: 0o600 });
console.log(`Created .env with ${SECRETS.size} generated secrets.`);
