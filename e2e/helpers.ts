import { expect, type Page } from "@playwright/test";

/** Signs in through the fake identity provider. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
  await page.getByLabel("Or another address").fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}
