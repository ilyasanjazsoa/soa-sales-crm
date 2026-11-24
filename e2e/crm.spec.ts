import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/* Milestone 2 journey as a seeded AE: import a CSV, find an imported account with a typo, claim it,
   move its stage, add a note and a contact, and see it on the pipeline board. */

test("import, search, claim, work an account, pipeline", async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Quillfeather ${tag} Logistics Park`;
  const csv = [
    "Account name,Property type,City,Contact first name,Contact email,Current provider,Signal",
    `${name},Industrial,Irving,Robin,robin@quill-${tag}.example,None,Cargo theft reported last month`,
    `Thornbury ${tag} Cold Storage,Cold chain warehouse,Plano,,,In-house,`,
    `Wrenfield ${tag} Medical Center,Medical office,Frisco,,,,`,
    `,Retail,Dallas,,,,`,
  ].join("\n");

  await signIn(page, "priya.raman@soa.example");
  await page.getByRole("link", { name: "Prospects" }).click();
  await expect(page.getByRole("heading", { name: "Prospect finder" })).toBeVisible();
  await shot("1-prospects");

  await page.getByRole("button", { name: "Import CSV" }).click();
  await page
    .getByLabel("Choose CSV file")
    .setInputFiles({ name: "prospects.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("3 new")).toBeVisible();
  await expect(page.getByText("1 invalid")).toBeVisible();
  await shot("2-import-preview");
  await page.getByRole("button", { name: "Import 3 accounts" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Imported 3 accounts" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Done" }).click();

  // One-letter typo in the search: "Quilfeather".
  await page.getByLabel("Search").fill(`Quilfeather ${tag}`);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Claim" }).click();
  await expect(row.getByRole("button", { name: "Open" })).toBeVisible();
  await row.getByRole("button", { name: "Open" }).click();

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("Owner: Priya Raman")).toBeVisible();
  const stage = page.getByLabel("Deal stage");
  await expect(stage).toHaveValue("lead");
  await expect(stage.locator("option", { hasText: "Contract sent" })).toHaveCount(0);
  await stage.selectOption("researched");
  await expect(stage).toHaveValue("researched");

  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  const noteBox = page.getByLabel("Add a note");
  await noteBox.fill("Walked the perimeter; gate 3 is unattended at night.");
  await noteBox.press("Enter");
  await expect(page.getByText("gate 3 is unattended")).toBeVisible();
  await expect(page.getByText("Stage moved from Lead to Researched")).toBeVisible();
  await shot("3-account");

  await page.getByRole("link", { name: "Pipeline" }).click();
  const column = page.getByRole("region", { name: "Researched" });
  await expect(column.getByText(name)).toBeVisible();
  await shot("4-pipeline");
});
