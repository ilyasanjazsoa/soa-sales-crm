import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/* Milestone 6 journey: build a proposal priced by the engine, generate the PDF, send the share link (an email draft
   for the rep), open the public page, send the contract, and (fake e-signature) sign it: the deal is Won. */

test("proposal → PDF → share link → contract → signed → won", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Kingfisher ${suffix} Storage`;
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
  await contact.getByLabel("First name").fill("Avery");
  await contact.getByLabel("Last name").fill("Stone");
  await contact.getByLabel("Email").fill(`avery.${suffix}@kingfisher.example`);
  await contact.getByRole("button", { name: "Add contact" }).click();
  await expect(contact).toBeHidden();

  // The reference package: 2 unarmed posts, 24/7, video, 36 months → $42,202.80 a month.
  await page.getByRole("tab", { name: "Proposal" }).click();
  await page.getByLabel("Guard posts").fill("2");
  await page.getByLabel("Coverage").selectOption("24_7");
  await page.getByLabel("Term").selectOption("36");
  await page.getByLabel("Remote video monitoring").check();
  await page.getByLabel("Mobile patrol, 3 visits a night").uncheck();
  await page.getByLabel("Client portal with live officer map").uncheck();
  await page.getByLabel("Armed officers").uncheck();
  await page.getByLabel("Site supervisor").uncheck();
  await expect(page.getByTestId("monthly-price")).toContainText("$42,202.80");
  await page.screenshot({ path: testInfo.outputPath("1-builder.png"), fullPage: true });
  await page.getByRole("button", { name: "Save as a new version" }).click();
  await page.getByRole("button", { name: "Generate PDF" }).click();
  await expect(page.getByRole("link", { name: "View PDF" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Send to client" }).click();

  // The email with the link waits on the Outreach tab for the rep to send.
  await expect(page.getByRole("tab", { name: "Outreach" })).toHaveAttribute("aria-selected", "true");
  const body = await page.getByLabel("Message").inputValue();
  const link = /(http:\/\/localhost:3000\/p\/[\w-]+)/.exec(body)?.[1];
  expect(link).toBeDefined();

  // The client opens it, with no session.
  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto(link ?? "");
  await expect(publicPage.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await expect(publicPage.getByRole("link", { name: "Contact Priya Raman" })).toBeVisible();
  await publicPage.screenshot({ path: testInfo.outputPath("2-public-proposal.png") });
  await visitor.close();

  await page.getByRole("tab", { name: "Contract" }).click();
  await page.getByRole("button", { name: "Send contract for signature" }).click();
  await expect(page.getByText("sent", { exact: true })).toBeVisible();
  await expect(page.getByText("Contract sent", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Client signed" }).click();
  await expect(page.getByRole("link", { name: "Signed copy" })).toBeVisible();
  await expect(page.getByText("Won", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`Hand off ${name} to operations`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("3-signed-won.png"), fullPage: true });
});
