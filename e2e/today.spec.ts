import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/* Milestone 7 journey: Today's numbers, next best actions and schedule; Ask Sales AI from the Ctrl/⌘+K palette. */

test("today → next best actions → ask with Ctrl+K", async ({ page }, testInfo) => {
  await signIn(page, "priya.raman@soa.example");
  await expect(page.getByText("Open pipeline")).toBeVisible();
  await expect(page.getByText("Weighted forecast")).toBeVisible();
  const actions = page.locator("section", { has: page.getByRole("heading", { name: "Next best actions" }) });
  await expect(actions.getByRole("listitem").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /^(Today|Next week)$/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-today.png"), fullPage: true });

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Ask Sales AI" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("Ask a question").fill("What's stalled?");
  await palette.getByRole("button", { name: "Ask" }).click();
  await expect(palette.getByText(/no activity in 7 days/)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath("2-ask.png") });
  const first = palette.getByRole("link").first();
  const label = (await first.textContent()) ?? "";
  await first.click();
  await expect(palette).toBeHidden();
  await expect(page.getByRole("heading", { name: label })).toBeVisible();
});
