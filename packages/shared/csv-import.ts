import { z } from "zod";
import { PROPERTY_TYPES, type PropertyType } from "./properties";

/* CSV import rules (docs/API.md "Imports and export"). Pure: the worker parses the file, maps columns, and calls
   these per row. CSV text is untrusted (CLAUDE.md rule 4): it is only ever stored as data. */

export const IMPORT_FIELDS = [
  "account_name",
  "property_type",
  "address",
  "city",
  "state",
  "postal_code",
  "owner_company",
  "size",
  "year_built",
  "occupancy",
  "current_provider",
  "contract_end_date",
  "website",
  "contact_first_name",
  "contact_last_name",
  "contact_title",
  "contact_email",
  "contact_phone",
  "signal",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  account_name: "Account name",
  property_type: "Property type",
  address: "Address",
  city: "City",
  state: "State",
  postal_code: "Postal code",
  owner_company: "Owner company",
  size: "Size",
  year_built: "Year built",
  occupancy: "Occupancy",
  current_provider: "Current provider",
  contract_end_date: "Contract end date",
  website: "Website",
  contact_first_name: "Contact first name",
  contact_last_name: "Contact last name",
  contact_title: "Contact title",
  contact_email: "Contact email",
  contact_phone: "Contact phone",
  signal: "Signal",
};

/** column index (as a string) → field, or "ignore" */
export const ColumnMap = z.record(z.string(), z.union([z.enum(IMPORT_FIELDS), z.literal("ignore")]));
export type ColumnMap = z.infer<typeof ColumnMap>;

const normalizeHeader = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const ALIASES: Record<string, ImportField> = {
  name: "account_name",
  account: "account_name",
  property: "account_name",
  type: "property_type",
  address_line: "address",
  street: "address",
  zip: "postal_code",
  zip_code: "postal_code",
  owner: "owner_company",
  provider: "current_provider",
  occupancy_pct: "occupancy",
  contract_end: "contract_end_date",
  url: "website",
  first_name: "contact_first_name",
  last_name: "contact_last_name",
  title: "contact_title",
  email: "contact_email",
  phone: "contact_phone",
};

/** Suggests a mapping from the header row. Each field is used at most once. */
export function suggestColumnMap(headers: readonly string[]): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<ImportField>();
  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    const field = (IMPORT_FIELDS as readonly string[]).includes(key) ? (key as ImportField) : ALIASES[key];
    if (field !== undefined && !used.has(field)) {
      used.add(field);
      map[String(index)] = field;
    } else {
      map[String(index)] = "ignore";
    }
  });
  return map;
}

export interface ImportedAccount {
  name: string;
  propertyType: PropertyType;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  ownerCompany: string | null;
  sizeText: string | null;
  yearBuilt: number | null;
  occupancyPct: number | null;
  currentProvider: string | null;
  contractEndDate: string | null;
  website: string | null;
}

export interface ImportedRow {
  account: ImportedAccount;
  contact: {
    firstName: string;
    lastName: string;
    title: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  signal: string | null;
}

export type RowResult = { ok: true; row: ImportedRow } | { ok: false; reason: string };

const clean = (value: string | undefined, max = 300): string | null => {
  const trimmed = (value ?? "").trim().replace(/\s+/g, " ");
  return trimmed === "" ? null : trimmed.slice(0, max);
};

/** "2026-01-31", "1/31/2026" or "01/31/26" → "2026-01-31"; null if blank; undefined if unreadable. */
export function parseDate(value: string | null): string | null | undefined {
  if (value === null) return null;
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3]) + (us[3]?.length === 2 ? 2000 : 0)];
  else return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

const EMAIL = z.email();
const PROPERTY_TYPE_LOOKUP = new Map<string, PropertyType>(PROPERTY_TYPES.map((type) => [type.toLowerCase(), type]));

/** Validates one mapped row. Never interprets the text beyond these checks. */
export function validateImportRow(values: Partial<Record<ImportField, string>>): RowResult {
  const name = clean(values.account_name, 200);
  if (name === null) return { ok: false, reason: "Missing account name" };

  const typeText = clean(values.property_type);
  const propertyType = typeText === null ? "Industrial" : PROPERTY_TYPE_LOOKUP.get(typeText.toLowerCase());
  if (propertyType === undefined) return { ok: false, reason: `Unknown property type "${typeText ?? ""}"` };

  const yearText = clean(values.year_built);
  const yearBuilt = yearText === null ? null : Number(yearText);
  if (yearBuilt !== null && (!Number.isInteger(yearBuilt) || yearBuilt < 1800 || yearBuilt > 2100)) {
    return { ok: false, reason: "Year built is not a year" };
  }

  const occupancyText = clean(values.occupancy)?.replace(/%$/, "") ?? null;
  const occupancyPct = occupancyText === null ? null : Number(occupancyText);
  if (occupancyPct !== null && (!Number.isInteger(occupancyPct) || occupancyPct < 0 || occupancyPct > 100)) {
    return { ok: false, reason: "Occupancy must be a whole number from 0 to 100" };
  }

  const contractEndDate = parseDate(clean(values.contract_end_date));
  if (contractEndDate === undefined) return { ok: false, reason: "Contract end date is not a date" };

  let website = clean(values.website);
  if (website !== null) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    try {
      const url = new URL(website);
      if (!url.hostname.includes(".")) throw new Error("no host");
      website = url.toString();
    } catch {
      return { ok: false, reason: "Website is not a web address" };
    }
  }

  const email = clean(values.contact_email)?.toLowerCase() ?? null;
  if (email !== null && !EMAIL.safeParse(email).success) return { ok: false, reason: "Contact email is not valid" };
  const firstName = clean(values.contact_first_name, 100);
  const contactDetails = [values.contact_last_name, values.contact_title, values.contact_email, values.contact_phone];
  if (firstName === null && contactDetails.some((value) => clean(value) !== null)) {
    return { ok: false, reason: "Contact first name is required with contact details" };
  }

  return {
    ok: true,
    row: {
      account: {
        name,
        propertyType,
        addressLine: clean(values.address),
        city: clean(values.city, 100),
        state: clean(values.state, 40),
        postalCode: clean(values.postal_code, 20),
        ownerCompany: clean(values.owner_company, 200),
        sizeText: clean(values.size, 200),
        yearBuilt,
        occupancyPct,
        currentProvider: clean(values.current_provider, 200),
        contractEndDate,
        website,
      },
      contact:
        firstName === null
          ? null
          : {
              firstName,
              lastName: clean(values.contact_last_name, 100) ?? "",
              title: clean(values.contact_title, 200),
              email,
              phone: clean(values.contact_phone, 40),
            },
      signal: clean(values.signal, 1000),
    },
  };
}

/** The duplicate key used by the database's accounts_dedupe index: lower(name), lower(coalesce(city, '')). */
export const dedupeKey = (name: string, city: string | null): string =>
  `${name.toLowerCase()}\u0000${(city ?? "").toLowerCase()}`;

/** Maps a raw CSV record to field values with a column map. */
export function applyColumnMap(record: readonly string[], map: ColumnMap): Partial<Record<ImportField, string>> {
  const values: Partial<Record<ImportField, string>> = {};
  for (const [index, field] of Object.entries(map)) {
    if (field === "ignore") continue;
    const value = record[Number(index)];
    if (value !== undefined) values[field] = value;
  }
  return values;
}
