import { runMigrations } from "../index";

// Blank values (as in .env.example) count as unset.
const pick = (value: string | undefined) => (value === undefined || value.trim() === "" ? undefined : value);
const url = pick(process.env.MIGRATION_DATABASE_URL) ?? pick(process.env.DATABASE_URL);
if (url === undefined || url === "") {
  process.stderr.write("DATABASE_URL is required (run pnpm env:init)\n");
  process.exit(1);
}
await runMigrations(url);
process.stdout.write("Migrations applied.\n");
