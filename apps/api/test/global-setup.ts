import { runMigrations } from "@soa/db";
import { createTestDatabase, dropTestDatabase } from "@soa/db/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

/** A migrated template database per run. Each test file copies it (test/db-setup.ts), so files never share data
    and the developer's database is never touched. */
export default async function setup(project: TestProject) {
  const template = await createTestDatabase("crm_test_template");
  await runMigrations(template.url);
  project.provide("templateDatabase", template.name);
  return async () => {
    await dropTestDatabase(template.name);
  };
}
