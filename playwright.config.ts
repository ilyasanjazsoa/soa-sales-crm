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
    // Fictional company settings and fast job ticks for the journeys (process env wins over the generated .env).
    env: {
      COMPANY_POSTAL_ADDRESS: "100 Example Plaza, Dallas, TX 75201",
      COMPANY_SIGNER_NAME: "Jordan Hale",
      COMPANY_SIGNER_EMAIL: "jordan.hale@soa.example",
      JOB_TICK_SECONDS: "3",
    },
    timeout: 120_000,
  },
});
