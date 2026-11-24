import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "shared", include: ["packages/shared/**/*.test.ts"], environment: "node" } },
      { test: { name: "api", include: ["apps/api/test/**/*.test.ts"], environment: "node", testTimeout: 30_000 } },
      {
        test: { name: "worker", include: ["apps/worker/test/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
      },
      { test: { name: "tooling", include: ["tests/**/*.test.ts"], environment: "node" } },
    ],
  },
});
