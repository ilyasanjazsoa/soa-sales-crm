import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
  ],
  // The whole stack with fake providers: api, worker and web (pnpm dev creates .env and migrates first).
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173/readyz",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
