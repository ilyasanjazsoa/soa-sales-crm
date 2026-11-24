import { expect, test } from "@playwright/test";

test("the empty shell renders in the dark zinc style", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Security Of America/ })).toBeVisible();
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).not.toBe("rgb(255, 255, 255)");
  await page.screenshot({ path: testInfo.outputPath("shell.png"), fullPage: true });
});
