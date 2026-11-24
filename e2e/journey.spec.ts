import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/* The main journey (ARCHITECTURE.md §17 item 4), with fakes: sign in → import CSV → research → draft and send email →
   simulated reply → book meeting → proposal → contract signed → deal Won → appears in the forecast.
   The reply is a real message to the rep through Mailpit, threaded with In-Reply-To; the worker's mail.sync finds
   it (JOB_TICK_SECONDS makes the tick fast in local runs and CI). */

const MAILPIT = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";

test("the whole sale, from import to Won", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Larkspur ${tag} Freight Terminal`;
  const email = `jordan.${tag}@larkspur.example`;

  // Sign in and import.
  await signIn(page, "priya.raman@soa.example");
  await page.getByRole("link", { name: "Prospects" }).click();
  await page.getByRole("button", { name: "Import CSV" }).click();
  const csv = [
    "Account name,Property type,City,Contact first name,Contact last name,Contact email,Current provider,Signal",
    `${name},Industrial,Irving,Jordan,Reyes,${email},None,Two trailers stolen from the yard in March.`,
  ].join("\n");
  await page
    .getByLabel("Choose CSV file")
    .setInputFiles({ name: "p.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Import 1 account" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Imported 1 account" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Search").fill(name);
  const row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "Claim" }).click();
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // Research: a note, then the AI brief (the deal moves to Researched).
  await page.getByLabel("Add a note").fill("Gate 3 is unattended at night and the yard lights are out.");
  await page.getByRole("button", { name: "Add note" }).click();
  await page.getByRole("button", { name: "Generate brief" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Researched", { exact: true }).first()).toBeVisible();
  await shot("1-researched");

  // Outreach: write with AI and send; the worker delivers it to Mailpit.
  await page.getByRole("tab", { name: "Outreach" }).click();
  await page.getByRole("button", { name: "Write with AI" }).click();
  await expect(page.getByLabel("Subject")).toHaveValue(`Security at ${name}`, { timeout: 30_000 });
  await page.getByRole("button", { name: "Send to Jordan" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });

  // The prospect replies on the thread.
  let messageId = "";
  await expect(async () => {
    const found = (await (
      await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()) as { messages: { MessageID: string }[] };
    messageId = found.messages[0]?.MessageID ?? "";
    expect(messageId).not.toBe("");
  }).toPass({ timeout: 30_000 });
  const sent = await request.post(`${MAILPIT}/api/v1/send`, {
    data: {
      From: { Email: email, Name: "Jordan Reyes" },
      To: [{ Email: "priya.raman@soa.example" }],
      Subject: `Re: Security at ${name}`,
      Text: "Sounds good, let's talk. Thursday works for a site walk.",
      Headers: { "In-Reply-To": `<${messageId.replace(/^<|>$/g, "")}>` },
    },
  });
  expect(sent.ok()).toBe(true);
  await expect(async () => {
    await page.reload();
    await page.getByRole("tab", { name: "Outreach" }).click();
    await expect(page.getByText("Reply", { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText("interested").first()).toBeVisible();
  await expect(page.getByText("Reply to Jordan Reyes")).toBeVisible();
  await shot("2-reply");

  // Book the site walk.
  await page.getByRole("tab", { name: "Meetings" }).click();
  await page.getByRole("button", { name: "Find best times" }).click();
  const prep = page.getByRole("dialog", { name: "Prep brief" });
  await expect(async () => {
    if (await prep.isVisible()) return;
    await page.getByRole("button", { name: "Book this time" }).first().click({ timeout: 5_000 });
    await expect(prep).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByText("Meeting set", { exact: true }).first()).toBeVisible();

  // Proposal: build, PDF, send (the email with the link is sent from the Outreach tab).
  await page.getByRole("tab", { name: "Proposal" }).click();
  await page.getByLabel("Guard posts").fill("2");
  await page.getByLabel("Coverage").selectOption("24_7");
  await page.getByRole("button", { name: "Save as a new version" }).click();
  await page.getByRole("button", { name: "Generate PDF" }).click();
  await expect(page.getByRole("link", { name: "View PDF" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Send to client" }).click();
  await expect(page.getByRole("tab", { name: "Outreach" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Send to Jordan" }).click();
  await expect(page.getByText("Proposal", { exact: true }).first()).toBeVisible();

  // Contract, signed through the (fake) e-signature callback: the deal is Won.
  await page.getByRole("tab", { name: "Contract" }).click();
  await page.getByRole("button", { name: "Send contract for signature" }).click();
  await page.getByRole("button", { name: "Client signed" }).click();
  await expect(page.getByRole("link", { name: "Signed copy" })).toBeVisible();
  await expect(page.getByText("Won", { exact: true }).first()).toBeVisible();
  await shot("3-won");

  // It appears in the forecast: in the Won column of the pipeline.
  await page.getByRole("link", { name: "Pipeline" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  await shot("4-pipeline");
});
