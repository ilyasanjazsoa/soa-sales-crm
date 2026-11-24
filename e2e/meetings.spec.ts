import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/* Milestone 5 journey: find times that allow for drive time, book one (the fake calendar), read the prep brief the
   worker writes, see the deal at Meeting set, and find the meeting on the Calendar screen. */

test("find times → book → prep brief → calendar", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Osprey ${suffix} Business Park`;
  await signIn(page, "priya.raman@soa.example");
  await page.getByRole("link", { name: "Prospects" }).click();
  await page.getByRole("button", { name: "Add account" }).click();
  const create = page.getByRole("dialog", { name: "Add account" });
  await create.getByLabel("Property or company name").fill(name);
  await create.getByLabel("City").fill("Irving");
  await create.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await page
    .locator("section", { has: page.getByRole("heading", { name: "Contacts" }) })
    .getByRole("button", { name: "Add", exact: true })
    .click();
  const contact = page.getByRole("dialog", { name: "Add contact" });
  await contact.getByLabel("First name").fill("Morgan");
  await contact.getByLabel("Last name").fill("Ellis");
  await contact.getByLabel("Email").fill(`morgan.${suffix}@osprey.example`);
  await contact.getByRole("button", { name: "Add contact" }).click();
  await expect(contact).toBeHidden();

  await page.getByRole("tab", { name: "Meetings" }).click();
  await page.getByRole("button", { name: "Find best times" }).click();
  const first = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Book this time" }) })
    .first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(first.getByText(/min drive from your/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-slots.png"), fullPage: true });

  // Both browser projects book as the same rep at once, so a time can be taken between finding and booking: the
  // app answers 409 with fresh times (an acceptance check), and the test books one of those.
  const prep = page.getByRole("dialog", { name: "Prep brief" });
  await expect(async () => {
    if (await prep.isVisible()) return;
    await page.getByRole("button", { name: "Book this time" }).first().click({ timeout: 5_000 });
    await expect(prep).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(prep.getByRole("heading", { name: "Logistics" })).toBeVisible({ timeout: 20_000 });
  await expect(prep.getByRole("heading", { name: "Questions to ask" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("2-prep-brief.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByText(`Site walk: ${name}`)).toBeVisible();
  await expect(page.getByText("Meeting set", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Calendar" }).click();
  await expect(page.getByText("Team stand-up").first()).toBeVisible();
  const booked = page.getByRole("button", { name: `Site walk: ${name}` });
  if ((await booked.count()) === 0) await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByRole("button", { name: `Site walk: ${name}` })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("3-calendar.png"), fullPage: true });
});
