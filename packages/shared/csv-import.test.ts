import { describe, expect, it } from "vitest";
import { applyColumnMap, dedupeKey, parseDate, suggestColumnMap, validateImportRow } from "./csv-import";

describe("suggestColumnMap", () => {
  it("recognises the documented headers and common aliases, each field once", () => {
    expect(suggestColumnMap(["Account Name", "Property Type", "City", "Email", "Notes", "account name"])).toEqual({
      "0": "account_name",
      "1": "property_type",
      "2": "city",
      "3": "contact_email",
      "4": "ignore",
      "5": "ignore",
    });
  });
});

describe("validateImportRow", () => {
  it("accepts a full row and normalises it", () => {
    const result = validateImportRow({
      account_name: "  Riverbend   Logistics ",
      property_type: "industrial",
      city: "Irving",
      contract_end_date: "1/31/2027",
      website: "riverbend.example",
      occupancy: "92%",
      contact_first_name: "Ana",
      contact_email: "ANA@Riverbend.example",
      signal: "Two trailer thefts last quarter",
    });
    expect(result).toMatchObject({
      ok: true,
      row: {
        account: {
          name: "Riverbend Logistics",
          propertyType: "Industrial",
          contractEndDate: "2027-01-31",
          website: "https://riverbend.example/",
          occupancyPct: 92,
        },
        contact: { firstName: "Ana", lastName: "", email: "ana@riverbend.example" },
        signal: "Two trailer thefts last quarter",
      },
    });
  });

  it("defaults a blank property type to Industrial, as in the demo", () => {
    expect(validateImportRow({ account_name: "X" })).toMatchObject({
      ok: true,
      row: { account: { propertyType: "Industrial" } },
    });
  });

  it.each([
    [{ city: "Irving" }, "Missing account name"],
    [{ account_name: "X", property_type: "Castle" }, 'Unknown property type "Castle"'],
    [{ account_name: "X", contact_first_name: "A", contact_email: "not-an-email" }, "Contact email is not valid"],
    [{ account_name: "X", contact_email: "a@b.example" }, "Contact first name is required with contact details"],
    [{ account_name: "X", year_built: "nineteen" }, "Year built is not a year"],
    [{ account_name: "X", occupancy: "140" }, "Occupancy must be a whole number from 0 to 100"],
    [{ account_name: "X", contract_end_date: "2026-02-30" }, "Contract end date is not a date"],
    [{ account_name: "X", website: "not a site" }, "Website is not a web address"],
  ])("rejects %j: %s", (values, reason) => {
    expect(validateImportRow(values)).toEqual({ ok: false, reason });
  });
});

describe("parseDate", () => {
  it.each([
    ["2026-01-31", "2026-01-31"],
    ["1/31/2026", "2026-01-31"],
    ["01/31/26", "2026-01-31"],
    ["2026-13-01", undefined],
    ["31/01/2026", undefined],
    ["tomorrow", undefined],
  ])("%s → %s", (input, output) => {
    expect(parseDate(input)).toBe(output);
  });
  it("treats blank as no date", () => {
    expect(parseDate(null)).toBeNull();
  });
});

describe("dedupeKey and applyColumnMap", () => {
  it("matches name and city in any letter case", () => {
    expect(dedupeKey("Acme Park", "Irving")).toBe(dedupeKey("ACME PARK", "irving"));
    expect(dedupeKey("Acme Park", null)).toBe(dedupeKey("acme park", ""));
    expect(dedupeKey("Acme Park", "Irving")).not.toBe(dedupeKey("Acme Park", "Plano"));
  });
  it("maps columns by index and ignores the rest", () => {
    expect(
      applyColumnMap(["A", "Industrial", "x"], { "0": "account_name", "1": "property_type", "2": "ignore" }),
    ).toEqual({
      account_name: "A",
      property_type: "Industrial",
    });
  });
});

import { ContactPatch } from "./crm";
describe("ContactPatch", () => {
  it("leaves out fields that were not sent (no defaults)", () => {
    expect(ContactPatch.parse({ doNotCall: true })).toEqual({ doNotCall: true });
    expect(ContactPatch.parse({ isPrimary: true })).toEqual({ isPrimary: true });
  });
});
