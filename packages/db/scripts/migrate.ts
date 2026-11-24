import { runMigrations } from "../index";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  process.stderr.write("DATABASE_URL is required (run pnpm env:init)\n");
  process.exit(1);
}
await runMigrations(url);
process.stdout.write("Migrations applied.\n");
