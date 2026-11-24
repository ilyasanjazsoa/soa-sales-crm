import { createDatabaseFromTemplate, dropTestDatabase } from "@soa/db/testing";
import { afterAll, beforeAll, inject } from "vitest";

/* Runs in every api test file: a private copy of the migrated template database. */

let current: { name: string; url: string } | undefined;

export function testDatabaseUrl(): string {
  if (current === undefined) throw new Error("test database not ready");
  return current.url;
}

beforeAll(async () => {
  current = await createDatabaseFromTemplate("crm_test", inject("templateDatabase"));
});

afterAll(async () => {
  if (current !== undefined) await dropTestDatabase(current.name);
});
