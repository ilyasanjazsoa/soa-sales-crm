import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/* Accessibility pass (milestone 8): every screen is checked with axe against WCAG 2 A and AA (labels, contrast,
   roles, names). Serious and critical problems fail the test. */

async function check(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const problems = result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) =>
        `${name}: ${violation.id} (${violation.nodes
          .map((node) => node.target.join(" "))
          .slice(0, 3)
          .join(", ")})`,
    );
  expect(problems).toEqual([]);
}

test.describe("accessibility", () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright passes fixtures first
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === "phone", "one viewport is enough");
  });

  test("sign-in page", async ({ page }) => {
    await page.goto("/login");
    await check(page, "login");
  });

  test("every signed-in screen, as a manager", async ({ page }) => {
    await signIn(page, "renee.hartwell@soa.example");
    for (const [path, name] of [
      ["/", "today"],
      ["/prospects", "prospects"],
      ["/pipeline", "pipeline"],
      ["/calendar", "calendar"],
      ["/ask", "ask"],
      ["/settings", "settings"],
      ["/admin/pricing", "admin pricing"],
      ["/admin/references", "admin references"],
      ["/admin/suppressions", "admin suppressions"],
      ["/admin/export", "admin export"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await check(page, name);
    }
  });

  test("account tabs", async ({ page }) => {
    await signIn(page, "priya.raman@soa.example");
    await page.goto("/prospects");
    await page
      .getByRole("link")
      .filter({ hasText: /Logistics|Storage|Park|Center|Campus/ })
      .first()
      .click();
    await expect(page.getByRole("tablist")).toBeVisible();
    for (const tab of ["Research", "Outreach", "Meetings", "Proposal", "Contract", "Timeline"]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.waitForLoadState("networkidle");
      await check(page, `account ${tab}`);
    }
  });

  test("admin pages for an admin", async ({ page }) => {
    await signIn(page, "admin@soa.example");
    for (const path of ["/admin/users", "/admin/audit"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await check(page, path);
    }
  });

  test("the keyboard reaches the main screens and dialogs", async ({ page }) => {
    await signIn(page, "priya.raman@soa.example");
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Ask Sales AI" });
    await expect(palette.getByLabel("Ask a question")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });
});
