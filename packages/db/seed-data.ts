/* Deterministic fictional seed data. Every person, company and address here is invented; emails use .example
   domains. Nothing is copied from reference/ (CLAUDE.md rule 10). */
import { createHash } from "node:crypto";
import type * as schema from "./schema";

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];

/** Stable UUIDs derived from a label, so the seed is identical every time. */
export function seedId(label: string): string {
  const hex = createHash("sha256").update(`soa-seed:${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const PROPERTY_TYPES = [
  "Industrial",
  "Cold chain warehouse",
  "Medical office",
  "Construction site",
  "Class A office",
  "Data center",
  "Multifamily",
  "Hospitality",
  "Retail",
  "Self storage",
] as const;

const CITIES = [
  "Irving",
  "Plano",
  "Arlington",
  "Dallas",
  "Fort Worth",
  "Frisco",
  "Garland",
  "Mesquite",
  "Grapevine",
  "Carrollton",
];
const PROVIDERS = ["None", "In-house", "Cameras only", "Regional guard company", "National guard company"];

const NAME_PARTS: Record<(typeof PROPERTY_TYPES)[number], [string[], string]> = {
  Industrial: [["Redbud", "Ironwood", "Prairie Gate", "Bluestem"], "Logistics Park"],
  "Cold chain warehouse": [["Northwind", "Glacier Point", "Frostline", "Polar Ridge"], "Cold Storage"],
  "Medical office": [["Cedar Hollow", "Willowbend", "Stonebriar", "Brookhaven"], "Medical Pavilion"],
  "Construction site": [["Summit Row", "Elm Fork", "Trinity Bend", "Canyon Creek"], "Tower (construction)"],
  "Class A office": [["Harborview", "Meridian Point", "Lakeshore", "Oakcrest"], "Plaza"],
  "Data center": [["Quartz Valley", "Silverline", "Copperfield", "Granite Run"], "Data Campus"],
  Multifamily: [["Magnolia", "Sycamore", "Larkspur", "Juniper"], "Residences"],
  Hospitality: [["Bayberry", "Pecan Grove", "Rosewood Lane", "Clearwater"], "Hotel"],
  Retail: [["Bridgewater", "Fairmont", "Westlake", "Hillcrest"], "Shopping Center"],
  "Self storage": [["Keystone", "Anchor Point", "Fieldstone", "Bramble"], "Self Storage"],
};

const FIRST_NAMES = [
  "Avery",
  "Blake",
  "Camila",
  "Darnell",
  "Elena",
  "Farid",
  "Grace",
  "Hector",
  "Imani",
  "Jonah",
  "Keira",
  "Luis",
  "Mina",
  "Nolan",
  "Opal",
  "Rafael",
  "Sienna",
  "Theo",
  "Uma",
  "Wes",
];
const LAST_NAMES = [
  "Abernathy",
  "Bellweather",
  "Calloway",
  "Delacroix",
  "Ekwueme",
  "Fairbanks",
  "Galloway",
  "Hollis",
  "Ishikawa",
  "Jessup",
  "Kowalczyk",
  "Lindgren",
  "Montoya",
  "Nakashima",
  "Oduya",
  "Pemberton",
  "Quintero",
  "Rasmussen",
  "Sorensen",
  "Thackeray",
];
const TITLES = [
  "Property Manager",
  "Facilities Director",
  "VP Operations",
  "Asset Manager",
  "General Manager",
  "Director of Security",
];

const SIGNALS: { kind: "incident" | "timing" | "tenant" | "growth" | "other"; text: string }[] = [
  { kind: "incident", text: "Two vehicle break-ins in the parking area reported last month" },
  { kind: "timing", text: "Current security contract ends this spring" },
  { kind: "tenant", text: "New anchor tenant asked for after-hours access control" },
  { kind: "growth", text: "Second building under construction, opening next year" },
  { kind: "incident", text: "Copper theft from the loading dock in the last 90 days" },
  { kind: "timing", text: "Insurance renewal requires a documented patrol log" },
  { kind: "other", text: "Owner is consolidating vendors across the portfolio" },
];

/** Annual values (integer cents) by deal index. */
const DEAL_STAGES = [
  "lead",
  "lead",
  "lead",
  "researched",
  "researched",
  "researched",
  "contacted",
  "contacted",
  "contacted",
  "meeting_set",
  "meeting_set",
  "proposal",
  "proposal",
  "contract_sent",
  "won",
] as const;
const DEAL_VALUES_CENTS = [
  18_720_000, 26_208_000, 9_360_000, 50_643_360, 31_200_000, 14_976_000, 44_928_000, 22_464_000, 12_480_000, 37_440_000,
  28_080_000, 63_648_000, 19_968_000, 41_184_000, 33_696_000,
];

const BASE_TIME = Date.UTC(2026, 0, 5, 15, 0, 0); // Mon 5 Jan 2026, 09:00 Central
const day = 24 * 60 * 60 * 1000;

export function buildSeed(domain: string) {
  const user = (key: string, name: string, role: "ae" | "manager", title: string, phone: string) => {
    const [first, last] = name.toLowerCase().split(" ");
    return {
      id: seedId(`user:${key}`),
      email: `${first ?? key}.${last ?? key}@${domain}`,
      name,
      role,
      title,
      phone,
      timezone: "America/Chicago",
      baseAddress: "2200 Ross Ave, Dallas, TX 75201",
      baseLat: 32.7876,
      baseLng: -96.7985,
    } satisfies Insert<typeof schema.users>;
  };

  const users = [
    user("manager", "Renee Hartwell", "manager", "Sales Manager", "(214) 555-0110"),
    user("ae1", "Priya Raman", "ae", "Account Executive", "(214) 555-0111"),
    user("ae2", "Marcus Ellery", "ae", "Account Executive", "(214) 555-0112"),
    user("ae3", "Jordan Okafor", "ae", "Account Executive", "(214) 555-0113"),
    user("ae4", "Tessa Lindqvist", "ae", "Senior Account Executive", "(214) 555-0114"),
    user("ae5", "Owen Castillo", "ae", "Account Executive", "(214) 555-0115"),
  ];
  const aes = users.filter((entry) => entry.role === "ae");
  const managerId = users[0]?.id;

  const pricingConfig = {
    id: seedId("pricing:2026"),
    effectiveFrom: "2026-01-01",
    hourlyRateCents: { unarmed: 2900, armed: 3800 },
    coverageHoursPerWeek: { "24_7": 168, nights: 84, business_hours: 60 },
    supervisorMultiplier: "1.05",
    addons: {
      patrol: { label: "Mobile patrol, 3 visits a night", monthlyCents: 145000 },
      video: { label: "Remote video monitoring", monthlyCents: 220000 },
      portal: { label: "Client portal with live officer map", monthlyCents: 0 },
    },
    termDiscounts: { "12": 0, "24": 0.03, "36": 0.05 },
    maxManualDiscount: "0.10",
    createdBy: managerId,
  } satisfies Insert<typeof schema.pricingConfigs>;

  const referenceRows: { key: string; named: string; anon: string; types: string[]; stats: Record<string, number> }[] =
    [
      {
        key: "ref1",
        named: "Lone Star Freight Terminal",
        anon: "a freight terminal we protect in Irving",
        types: ["Industrial", "Cold chain warehouse"],
        stats: { patrolCompliancePct: 98.6, avgResponseMin: 4 },
      },
      {
        key: "ref2",
        named: "Parkside Health Campus",
        anon: "a medical campus we protect in Plano",
        types: ["Medical office"],
        stats: { patrolCompliancePct: 99.1, avgResponseMin: 3 },
      },
      {
        key: "ref3",
        named: "Crestview Tower Builders",
        anon: "a downtown high-rise construction site",
        types: ["Construction site"],
        stats: { theftIncidentsDownPct: 82, avgResponseMin: 6 },
      },
      {
        key: "ref4",
        named: "Arbor Point Apartments",
        anon: "a 400-unit apartment community in Arlington",
        types: ["Multifamily", "Hospitality"],
        stats: { patrolCompliancePct: 97.8, avgResponseMin: 5 },
      },
    ];
  const clientReferences = referenceRows.map(
    (ref) =>
      ({
        id: seedId(`reference:${ref.key}`),
        labelNamed: ref.named,
        labelAnonymized: ref.anon,
        propertyTypes: ref.types,
        stats: ref.stats,
        namedPermission: false, // DECISIONS.md item H default: all anonymized
      }) satisfies Insert<typeof schema.clientReferences>,
  );

  const accounts: Insert<typeof schema.accounts>[] = [];
  const contacts: Insert<typeof schema.contacts>[] = [];
  const signals: Insert<typeof schema.signals>[] = [];
  for (let index = 0; index < 40; index += 1) {
    const type = PROPERTY_TYPES[index % PROPERTY_TYPES.length] ?? "Industrial";
    const [prefixes, suffix] = NAME_PARTS[type];
    const name = `${prefixes[Math.floor(index / PROPERTY_TYPES.length) % prefixes.length] ?? "Harbor"} ${suffix}`;
    const city = CITIES[(index * 3) % CITIES.length] ?? "Dallas";
    // Accounts 0..24 are owned by the five AEs (five each); 25..39 are the unassigned pool.
    const owner = index < 25 ? aes[index % aes.length] : undefined;
    const accountId = seedId(`account:${String(index)}`);
    const companyDomain = `${name
      .toLowerCase()
      .replace(/[^a-z]+/g, "-")
      .replace(/^-|-$/g, "")}.example`;
    const contractEnd =
      index % 4 === 0 ? new Date(BASE_TIME + (60 + index * 7) * day).toISOString().slice(0, 10) : null;
    accounts.push({
      id: accountId,
      name,
      propertyType: type,
      addressLine: `${String(100 + index * 37)} ${["Commerce", "Main", "Industrial", "Market", "Park"][index % 5] ?? "Main"} St`,
      city,
      state: "TX",
      postalCode: String(75000 + index * 13),
      ownerCompany: `${prefixes[0] ?? "Harbor"} Property Partners`,
      sizeText: `${String(80 + index * 15)},000 sq ft`,
      yearBuilt: 1990 + (index % 30),
      occupancyPct: 70 + (index % 30),
      currentProvider: PROVIDERS[index % PROVIDERS.length] ?? "None",
      contractTiming: contractEnd === null ? null : `Contract ends ${contractEnd}`,
      contractEndDate: contractEnd,
      website: `https://www.${companyDomain}`,
      ownerUserId: owner?.id ?? null,
      createdBy: managerId,
      source: index % 3 === 0 ? "csv" : "manual",
      createdAt: new Date(BASE_TIME - (40 - index) * day),
      updatedAt: new Date(BASE_TIME - (40 - index) * day),
    });

    const contactCount = 1 + (index % 3 === 0 ? 1 : 0);
    for (let c = 0; c < contactCount; c += 1) {
      const n = index * 2 + c;
      const first = FIRST_NAMES[n % FIRST_NAMES.length] ?? "Alex";
      const last = LAST_NAMES[(n * 7) % LAST_NAMES.length] ?? "Smith";
      contacts.push({
        id: seedId(`contact:${String(index)}:${String(c)}`),
        accountId,
        firstName: first,
        lastName: last,
        title: TITLES[n % TITLES.length] ?? "Property Manager",
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${companyDomain}`,
        phone: `(972) 555-${String(1000 + n).slice(-4)}`,
        phoneType: c === 0 ? "business" : "mobile",
        isPrimary: c === 0,
        contactPref: c === 0 && index % 2 === 0 ? "Prefers morning meetings" : null,
      });
    }

    const signalCount = index % 3;
    for (let s = 0; s < signalCount; s += 1) {
      const signal = SIGNALS[(index + s * 2) % SIGNALS.length] ?? SIGNALS[0];
      if (signal === undefined) continue;
      signals.push({
        id: seedId(`signal:${String(index)}:${String(s)}`),
        accountId,
        text: signal.text,
        kind: signal.kind,
        confirmed: true,
        createdBy: owner?.id ?? managerId,
        observedOn: new Date(BASE_TIME - (10 + s * 20) * day).toISOString().slice(0, 10),
      });
    }
  }

  const deals: Insert<typeof schema.deals>[] = [];
  const stageHistory: Insert<typeof schema.dealStageHistory>[] = [];
  const activities: Insert<typeof schema.activities>[] = [];
  const STAGE_ORDER = ["lead", "researched", "contacted", "meeting_set", "proposal", "contract_sent", "won"] as const;
  DEAL_STAGES.forEach((stage, index) => {
    const account = accounts[index];
    if (account?.id === undefined || account.ownerUserId === null || account.ownerUserId === undefined) return;
    const dealId = seedId(`deal:${String(index)}`);
    const stageAt = new Date(BASE_TIME - (14 - index) * day);
    deals.push({
      id: dealId,
      accountId: account.id,
      ownerUserId: account.ownerUserId,
      name: `${account.name} security`,
      stage,
      status: stage === "won" ? "won" : "open",
      stageChangedAt: stageAt,
      annualValueCents: DEAL_VALUES_CENTS[index] ?? 0,
      expectedClose: new Date(BASE_TIME + (30 + index * 5) * day).toISOString().slice(0, 10),
      lastActivityAt: stageAt,
      createdAt: new Date(BASE_TIME - 30 * day),
      updatedAt: stageAt,
    });
    const reached = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage) + 1);
    reached.forEach((toStage, step) => {
      const at = new Date(BASE_TIME - 30 * day + step * day);
      stageHistory.push({
        id: seedId(`history:${String(index)}:${String(step)}`),
        dealId,
        fromStage: step === 0 ? null : (reached[step - 1] ?? null),
        toStage,
        changedBy: account.ownerUserId,
        changedAt: at,
      });
      activities.push({
        id: seedId(`activity:${String(index)}:${String(step)}`),
        accountId: account.id ?? "",
        dealId,
        userId: account.ownerUserId,
        type: "stage_change",
        subject: step === 0 ? "Deal created" : `Stage moved to ${toStage.replace("_", " ")}`,
        meta: { from: step === 0 ? null : reached[step - 1], to: toStage },
        occurredAt: at,
      });
    });
  });

  return { users, pricingConfig, clientReferences, accounts, contacts, signals, deals, stageHistory, activities };
}
