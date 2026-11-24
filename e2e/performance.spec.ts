import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/* Milestone 8: a page load of Today, Pipeline and Account is under 1.5 s on the seed data (from navigation to the
   screen's main content, data included). */

const LIMIT_MS = 1_500;

async function timed(page: Page, path: string, ready: () => Promise<void>): Promise<number> {
  const started = Date.now();
  await page.goto(path);
  await ready();
  return Date.now() - started;
}

test("Today, Pipeline and Account load in under 1.5 s", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "one viewport is enough");
  await signIn(page, "priya.raman@soa.example");
  const today = await timed(page, "/", async () => {
    await expect(page.getByRole("heading", { name: "Next best actions" })).toBeVisible();
    await expect(page.getByText("Open pipeline")).toBeVisible();
  });
  const accountLink = (await page.locator('a[href^="/accounts/"]').first().getAttribute("href"))?.split("?")[0];
  const pipeline = await timed(page, "/pipeline", async () => {
    await expect(page.getByText("Weighted forecast")).toBeVisible();
    await expect(page.getByText(/\$\d/).first()).toBeVisible();
  });
  const account = await timed(page, accountLink ?? "/", async () => {
    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
  });
  testInfo.annotations.push({
    type: "timings",
    description: `today ${String(today)} ms, pipeline ${String(pipeline)} ms, account ${String(account)} ms`,
  });
  console.log(`timings: today ${String(today)} ms, pipeline ${String(pipeline)} ms, account ${String(account)} ms`);
  expect(today).toBeLessThan(LIMIT_MS);
  expect(pipeline).toBeLessThan(LIMIT_MS);
  expect(account).toBeLessThan(LIMIT_MS);
});
