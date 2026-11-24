/* Fictional demo data (CLAUDE.md rule 9). Refuses to run in production or against a non-.example domain.
   Usage: pnpm db:seed            (only into an empty database)
          pnpm db:seed --reset    (local only: empties every table first) */
import { createDb } from "../index";
import { seedDatabase } from "../seed";

const url = process.env.DATABASE_URL;
const domain = (process.env.ALLOWED_EMAIL_DOMAIN ?? "soa.example").toLowerCase();

if (url === undefined || url === "") {
  process.stderr.write("DATABASE_URL is required (run pnpm env:init)\n");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" || !domain.endsWith(".example")) {
  process.stderr.write("Refusing to seed: seed data is for local and CI databases with a .example domain only.\n");
  process.exit(1);
}

const handle = createDb(url, { max: 1 });
try {
  const data = await seedDatabase(handle.db, { domain, reset: process.argv.includes("--reset") });
  process.stdout.write(
    `Seeded ${String(data.users.length)} users, ${String(data.accounts.length)} accounts, ` +
      `${String(data.contacts.length)} contacts, ${String(data.signals.length)} signals, ` +
      `${String(data.deals.length)} deals, ${String(data.clientReferences.length)} client references and 1 pricing config.\n` +
      `Sign in locally as one of: ${data.users.map((user) => user.email).join(", ")}, ` +
      `or ${process.env.BOOTSTRAP_ADMIN_EMAIL ?? "the bootstrap admin"} (created as admin on first sign-in).\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
