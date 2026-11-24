import { z } from "zod";
import { ColumnMap, IMPORT_FIELDS } from "./csv-import";
import { Package } from "./pricing";
import { LOST_REASONS, PROPERTY_TYPES } from "./properties";
import { DEAL_STAGES } from "./stages";

/* Shapes for accounts, contacts, signals, deals, tasks, timeline, imports (docs/API.md). */

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();
const isoDate = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });

export const PropertyTypeSchema = z.enum(PROPERTY_TYPES);
export const DealStageSchema = z.enum(DEAL_STAGES);
export const DealStatusSchema = z.enum(["open", "won", "lost"]);
export const LostReasonSchema = z.enum(LOST_REASONS);

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ───────── people ─────────
export const UserRef = z.object({ id: z.uuid(), name: z.string() });
export type UserRef = z.infer<typeof UserRef>;

// ───────── contacts ─────────
export const Contact = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  phoneType: z.enum(["business", "mobile", "unknown"]),
  linkedinUrl: z.string().nullable(),
  contactPref: z.string().nullable(),
  isPrimary: z.boolean(),
  emailStatus: z.enum(["ok", "unsubscribed", "bounced"]),
  doNotCall: z.boolean(),
});
export type Contact = z.infer<typeof Contact>;

export const ContactInput = z
  .object({
    firstName: text(100),
    lastName: z.string().trim().max(100).default(""),
    title: optionalText(200),
    email: z
      .email()
      .toLowerCase()
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    phone: optionalText(40),
    phoneType: z.enum(["business", "mobile", "unknown"]).optional(),
    linkedinUrl: optionalText(300),
    contactPref: optionalText(300),
    isPrimary: z.boolean().optional(),
    doNotCall: z.boolean().optional(),
  })
  .strict();
export type ContactInput = z.infer<typeof ContactInput>;
export const ContactPatch = ContactInput.partial().strict();
export type ContactPatch = z.infer<typeof ContactPatch>;

// ───────── signals ─────────
export const SignalKind = z.enum(["incident", "timing", "tenant", "growth", "other"]);
export const Signal = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  text: z.string(),
  kind: SignalKind,
  sourceId: z.uuid().nullable(),
  observedOn: isoDate.nullable(),
  confirmed: z.boolean(),
  byAi: z.boolean(),
  createdAt: timestamp,
});
export type Signal = z.infer<typeof Signal>;
export const SignalInput = z
  .object({ text: text(500), kind: SignalKind.default("other"), observedOn: isoDate.nullable().optional() })
  .strict();
export type SignalInput = z.infer<typeof SignalInput>;
export const SignalPatch = z
  .object({ text: text(500), kind: SignalKind, observedOn: isoDate.nullable(), confirmed: z.literal(true) })
  .partial()
  .strict();
export type SignalPatch = z.infer<typeof SignalPatch>;

// ───────── deals ─────────
export const Deal = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  accountName: z.string(),
  owner: UserRef,
  name: z.string(),
  stage: DealStageSchema,
  status: DealStatusSchema,
  stageChangedAt: timestamp,
  package: Package.nullable(),
  annualValueCents: z.number().int(),
  expectedClose: isoDate.nullable(),
  lostReason: z.string().nullable(),
  lastActivityAt: timestamp,
  createdAt: timestamp,
});
export type Deal = z.infer<typeof Deal>;
export const DealPage = Page(Deal);
export type DealPage = z.infer<typeof DealPage>;

export const DealPatch = z
  .object({ name: text(200), package: Package, expectedClose: isoDate.nullable() })
  .partial()
  .strict();
export type DealPatch = z.infer<typeof DealPatch>;
export const StageMoveRequest = z.object({ stage: DealStageSchema }).strict();
export const LoseRequest = z.object({ reason: LostReasonSchema, note: z.string().trim().max(500).optional() }).strict();
export const CreateDealRequest = z
  .object({ name: text(200).optional(), package: Package.optional(), expectedClose: isoDate.nullable().optional() })
  .strict();

export const DealsQuery = ListQuery.extend({
  stage: DealStageSchema.optional(),
  status: DealStatusSchema.optional(),
  owner: z.union([z.literal("me"), z.literal("all"), z.uuid()]).optional(),
});

export const ForecastResponse = z.object({
  stages: z.array(
    z.object({
      stage: DealStageSchema,
      probabilityBp: z.number().int(),
      count: z.number().int(),
      valueCents: z.number().int(),
      weightedCents: z.number().int(),
    }),
  ),
  openCount: z.number().int(),
  openValueCents: z.number().int(),
  weightedCents: z.number().int(),
  wonValueCents: z.number().int(),
});
export type ForecastResponse = z.infer<typeof ForecastResponse>;

// ───────── accounts ─────────
export const AccountSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  propertyType: z.string(),
  city: z.string().nullable(),
  ownerCompany: z.string().nullable(),
  owner: UserRef.nullable(),
  fitScore: z.number().int().nullable(),
  fitReasons: z.array(z.string()),
  deal: z.object({ id: z.uuid(), stage: DealStageSchema, status: DealStatusSchema }).nullable(),
});
export type AccountSummary = z.infer<typeof AccountSummary>;
export const AccountPage = Page(AccountSummary).extend({ hiddenFromYou: z.number().int().nullable() });
export type AccountPage = z.infer<typeof AccountPage>;

export const AccountsQuery = ListQuery.extend({
  q: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  type: z.string().trim().max(100).optional(),
  minFit: z.coerce.number().int().min(0).max(100).optional(),
  owner: z.union([z.enum(["me", "unassigned", "all"]), z.uuid()]).optional(),
});
export type AccountsQuery = z.infer<typeof AccountsQuery>;

export const AccountFields = z.object({
  name: text(200),
  propertyType: PropertyTypeSchema,
  addressLine: optionalText(300),
  city: optionalText(100),
  state: optionalText(40),
  postalCode: optionalText(20),
  ownerCompany: optionalText(200),
  sizeText: optionalText(200),
  yearBuilt: z.number().int().min(1800).max(2100).nullable().optional(),
  occupancyPct: z.number().int().min(0).max(100).nullable().optional(),
  currentProvider: optionalText(200),
  contractTiming: optionalText(300),
  contractEndDate: isoDate.nullable().optional(),
  website: z
    .url({ protocol: /^https?$/ })
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  doNotContact: z.boolean().optional(),
});

export const CreateAccountRequest = AccountFields.extend({ contact: ContactInput.optional() }).strict();
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;
export const AccountPatch = AccountFields.partial().strict();
export type AccountPatch = z.infer<typeof AccountPatch>;

export const Account = z.object({
  id: z.uuid(),
  name: z.string(),
  propertyType: z.string(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  ownerCompany: z.string().nullable(),
  sizeText: z.string().nullable(),
  yearBuilt: z.number().int().nullable(),
  occupancyPct: z.number().int().nullable(),
  currentProvider: z.string().nullable(),
  contractTiming: z.string().nullable(),
  contractEndDate: isoDate.nullable(),
  website: z.string().nullable(),
  isExistingClient: z.boolean(),
  doNotContact: z.boolean(),
  fitScore: z.number().int().nullable(),
  fitReasons: z.array(z.string()),
  source: z.enum(["manual", "csv", "provider"]),
  owner: UserRef.nullable(),
  createdAt: timestamp,
  canEdit: z.boolean(),
  contacts: z.array(Contact),
  deal: Deal.nullable(),
  latestBriefId: z.uuid().nullable(),
  counts: z.object({ signals: z.number().int(), sources: z.number().int(), openTasks: z.number().int() }),
});
export type Account = z.infer<typeof Account>;

export const AssignRequest = z.object({ ownerUserId: z.uuid().nullable() }).strict();

// ───────── tasks ─────────
export const Task = z.object({
  id: z.uuid(),
  accountId: z.uuid().nullable(),
  accountName: z.string().nullable(),
  dealId: z.uuid().nullable(),
  title: z.string(),
  dueAt: timestamp.nullable(),
  doneAt: timestamp.nullable(),
  createdAt: timestamp,
});
export type Task = z.infer<typeof Task>;
export const TaskList = z.object({ items: z.array(Task) });
export const TaskInput = z
  .object({ title: text(300), accountId: z.uuid().optional(), dueAt: timestamp.nullable().optional() })
  .strict();
export const TaskPatch = z
  .object({ title: text(300), dueAt: timestamp.nullable(), done: z.boolean() })
  .partial()
  .strict();
export const TasksQuery = z.object({
  open: z.enum(["true", "false"]).optional(),
  accountId: z.uuid().optional(),
});

// ───────── timeline ─────────
export const Activity = z.object({
  id: z.uuid(),
  type: z.string(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  user: UserRef.nullable(),
  occurredAt: timestamp,
  meta: z.record(z.string(), z.unknown()),
});
export type Activity = z.infer<typeof Activity>;
export const ActivityPage = Page(Activity);
export const NoteInput = z.object({ text: text(5000) }).strict();

// ───────── imports ─────────
export const ImportFieldSchema = z.enum(IMPORT_FIELDS);
export const ImportUploadResponse = z.object({
  id: z.uuid(),
  filename: z.string(),
  headers: z.array(z.string()),
  sampleRows: z.array(z.array(z.string())),
  rowsTotal: z.number().int(),
  suggestedMap: ColumnMap,
});
export type ImportUploadResponse = z.infer<typeof ImportUploadResponse>;
export const ImportPreviewRequest = z.object({ columnMap: ColumnMap, assignToMe: z.boolean().default(false) }).strict();
export const ImportRowError = z.object({ row: z.number().int(), name: z.string().nullable(), reason: z.string() });
export const ImportPreviewResponse = z.object({
  newCount: z.number().int(),
  duplicateCount: z.number().int(),
  invalidCount: z.number().int(),
  skipped: z.array(ImportRowError),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponse>;
export const ImportStatus = z.object({
  id: z.uuid(),
  filename: z.string(),
  status: z.enum(["uploaded", "previewed", "running", "done", "failed"]),
  rowsTotal: z.number().int().nullable(),
  rowsCreated: z.number().int().nullable(),
  rowsSkipped: z.number().int().nullable(),
  errors: z.array(ImportRowError),
  createdAt: timestamp,
});
export type ImportStatus = z.infer<typeof ImportStatus>;
