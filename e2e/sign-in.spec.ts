import { expect, test } from "@playwright/test";

/* Milestone 1 journey with the fake identity provider: sign in as the bootstrap admin, add a user,
   change My settings, sign out. Screenshots are saved as evidence. */

test("sign in, manage users and settings, sign out", async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("link", { name: "Sign in with Microsoft" })).toBeVisible();
  await shot("1-login");

  await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByRole("heading", { name: "Fake identity provider" })).toBeVisible();
  await page.getByLabel("Or another address").fill("admin@soa.example");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  await shot("2-today");

  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  const email = `e2e.${testInfo.project.name}.${Date.now().toString(36)}@soa.example`;
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Name", { exact: true }).fill("E2E Test Rep");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText(email)).toBeVisible();
  await shot("3-admin-users");

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Phone").fill("(214) 555-0199");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await shot("4-settings");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("a person who is not a user is refused", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
  await page.getByLabel("Or another address").fill("stranger@soa.example");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login\?error=not_allowed$/);
  await expect(page.getByRole("alert")).toContainText("can't sign in");
});
