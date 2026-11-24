import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/* Milestone 4 journey: write an email with AI, see the checks and locked footer, send it (the worker delivers it to
   Mailpit), unsubscribe with the link in the delivered email, and see the next email to that address blocked. */

const MAILPIT = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";

test("AI email → checks → send → delivered with footer → unsubscribe → blocked", async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Heron ${suffix} Distribution Center`;
  const email = `dana.${suffix}@heron.example`;
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
  await contact.getByLabel("First name").fill("Dana");
  await contact.getByLabel("Last name").fill("Whitfield");
  await contact.getByLabel("Email").fill(email);
  await contact.getByRole("button", { name: "Add contact" }).click();
  await expect(contact).toBeHidden();

  await page.getByRole("tab", { name: "Outreach" }).click();
  await page.getByRole("button", { name: "Write with AI" }).click();
  await expect(page.getByLabel("Subject")).toHaveValue(`Security at ${name}`, { timeout: 20_000 });
  await expect(page.getByText("Added automatically. Can't be removed.")).toBeVisible();
  await expect(page.getByText("Recipient can be emailed")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-outreach-draft.png"), fullPage: true });

  await page.getByRole("button", { name: "Send to Dana" }).click();
  await expect(page.getByText(`To ${email}`)).toBeVisible();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Contacted", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("2-outreach-sent.png"), fullPage: true });

  // The worker delivered it to Mailpit, ending with the signature, the postal address and the unsubscribe link.
  let text = "";
  await expect(async () => {
    const search = (await (
      await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()) as {
      messages: { ID: string }[];
    };
    const id = search.messages[0]?.ID;
    expect(id).toBeDefined();
    text = ((await (await request.get(`${MAILPIT}/api/v1/message/${id ?? ""}`)).json()) as { Text: string }).Text;
  }).toPass({ timeout: 20_000 });
  expect(text).toContain("Priya Raman");
  const link = /Unsubscribe: (http\S+)\s*$/.exec(text)?.[1];
  expect(link).toBeDefined();

  await page.goto(link ?? "");
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("3-unsubscribed.png") });

  await page.goBack();
  await page.goBack();
  await page.getByRole("tab", { name: "Outreach" }).click();
  await page.getByRole("button", { name: "Write it myself" }).click();
  await expect(page.getByText(`${email} is on the suppression list (unsubscribe)`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send to Dana" })).toBeDisabled();
});
