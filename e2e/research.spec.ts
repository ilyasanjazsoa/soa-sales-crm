import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/* Milestone 3 journey: add a research note, generate the AI brief (fake model locally and in CI), see citations,
   the server-written price, and the deal move to Researched. */

test("research note → AI brief with citations → deal researched", async ({ page }, testInfo) => {
  const name = `Kestrel ${testInfo.project.name}${Date.now().toString(36)} Logistics Park`;
  await signIn(page, "priya.raman@soa.example");
  await page.getByRole("link", { name: "Prospects" }).click();
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await dialog.getByLabel("Property or company name").fill(name);
  await dialog.getByLabel("City").fill("Irving");
  await dialog.getByLabel("Current security").fill("Cameras only");
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await expect(page.getByRole("tab", { name: "Research" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Generate brief" })).toBeDisabled();
  await page
    .getByLabel("Add a note")
    .fill("Two trailer thefts happened in the north yard in March. Only cameras watch the gate at night.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Two trailer thefts happened")).toBeVisible();

  await page.getByRole("button", { name: "Generate brief" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "source 1" }).first()).toBeVisible();
  await expect(page.getByText(/Price: .* a year \(.* a month\)\./)).toBeVisible();
  await expect(page.getByText("Researched", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-research-brief.png"), fullPage: true });
});
