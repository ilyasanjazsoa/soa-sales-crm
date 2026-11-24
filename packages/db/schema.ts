/* Drizzle schema for docs/DATA_MODEL.sql. The generated migration must produce exactly that schema:
   packages/db/test/schema-match.test.ts loads both and compares the catalogs, including constraint and index
   names. Constraint names below are the ones PostgreSQL gives the SQL file's unnamed constraints. */
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const now = () => sql`now()`;
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const fkey = (table: string, column: string) => `${table}_${column}_fkey`;
const raw = (expression: string): SQL => sql.raw(expression);

// ───────── enums ─────────
export const userRole = pgEnum("user_role", ["ae", "manager", "admin"]);
export const mailProvider = pgEnum("mail_provider", ["microsoft", "google"]);
export const dealStage = pgEnum("deal_stage", [
  "lead",
  "researched",
  "contacted",
  "meeting_set",
  "proposal",
  "contract_sent",
  "won",
]);
export const dealStatus = pgEnum("deal_status", ["open", "won", "lost"]);
export const outreachChannel = pgEnum("outreach_channel", ["email", "call", "voicemail", "linkedin"]);
export const draftStatus = pgEnum("draft_status", ["draft", "sent", "logged", "discarded"]);
export const emailDirection = pgEnum("email_direction", ["out", "in"]);
export const emailStatus = pgEnum("email_status", ["queued", "sent", "failed", "bounced", "received"]);
export const contactEmailStatus = pgEnum("contact_email_status", ["ok", "unsubscribed", "bounced"]);
export const phoneType = pgEnum("phone_type", ["business", "mobile", "unknown"]);
export const suppressionReason = pgEnum("suppression_reason", ["unsubscribe", "bounce", "complaint", "manual"]);
export const meetingKind = pgEnum("meeting_kind", ["site_walk", "call", "video", "internal"]);
export const meetingStatus = pgEnum("meeting_status", ["scheduled", "done", "cancelled", "no_show"]);
export const proposalStatus = pgEnum("proposal_status", ["draft", "sent", "viewed", "accepted", "expired"]);
export const contractStatus = pgEnum("contract_status", ["draft", "sent", "viewed", "signed", "declined", "voided"]);
export const sourceKind = pgEnum("source_kind", ["website", "search", "upload", "rep_note", "provider"]);
export const accountSource = pgEnum("account_source", ["manual", "csv", "provider"]);
export const activityType = pgEnum("activity_type", [
  "note",
  "email_out",
  "email_in",
  "call",
  "voicemail",
  "linkedin",
  "meeting",
  "stage_change",
  "proposal_sent",
  "proposal_viewed",
  "contract_sent",
  "contract_signed",
  "task_done",
  "owner_change",
]);

// ───────── people and sessions ─────────
export const users = pgTable(
  "users",
  {
    id: id(),
    email: citext("email").notNull().unique("users_email_key"),
    name: text("name").notNull(),
    title: text("title").notNull().default("Account Executive"),
    phone: text("phone"),
    role: userRole("role").notNull().default("ae"),
    timezone: text("timezone").notNull().default("America/Chicago"),
    baseAddress: text("base_address"),
    baseLat: doublePrecision("base_lat"),
    baseLng: doublePrecision("base_lng"),
    workdayStart: time("workday_start").notNull().default("08:00"),
    workdayEnd: time("workday_end").notNull().default("17:30"),
    dailySendCap: integer("daily_send_cap").notNull().default(50),
    active: boolean("active").notNull().default(true),
    createdAt: tstz("created_at").notNull().default(now()),
    updatedAt: tstz("updated_at").notNull().default(now()),
  },
  () => [check("users_daily_send_cap_check", raw("daily_send_cap BETWEEN 0 AND 500"))],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    userId: uuid("user_id").notNull(),
    provider: mailProvider("provider").notNull(),
    subject: text("subject").notNull(),
    scopes: text("scopes").array().notNull(),
    accessTokenEnc: bytea("access_token_enc").notNull(),
    refreshTokenEnc: bytea("refresh_token_enc").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    mailSyncCursor: text("mail_sync_cursor"),
    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    updatedAt: tstz("updated_at").notNull().default(now()),
  },
  (t) => [
    primaryKey({ name: "oauth_accounts_pkey", columns: [t.userId, t.provider] }),
    unique("oauth_accounts_provider_subject_key").on(t.provider, t.subject),
    foreignKey({ name: fkey("oauth_accounts", "user_id"), columns: [t.userId], foreignColumns: [users.id] }).onDelete(
      "cascade",
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userId: uuid("user_id").notNull(),
    createdAt: tstz("created_at").notNull().default(now()),
    lastSeenAt: tstz("last_seen_at").notNull().default(now()),
    expiresAt: tstz("expires_at").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    foreignKey({ name: fkey("sessions", "user_id"), columns: [t.userId], foreignColumns: [users.id] }).onDelete(
      "cascade",
    ),
    index("sessions_user_idx").on(t.userId),
  ],
);

// ───────── accounts ─────────
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    name: text("name").notNull(),
    propertyType: text("property_type").notNull(),
    addressLine: text("address_line"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    ownerCompany: text("owner_company"),
    sizeText: text("size_text"),
    yearBuilt: integer("year_built"),
    occupancyPct: integer("occupancy_pct"),
    currentProvider: text("current_provider"),
    contractTiming: text("contract_timing"),
    contractEndDate: date("contract_end_date"),
    website: text("website"),
    isExistingClient: boolean("is_existing_client").notNull().default(false),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    fitScore: integer("fit_score"),
    fitReasons: jsonb("fit_reasons").$type<string[]>().notNull().default(raw("'[]'")),
    source: accountSource("source").notNull().default("manual"),
    sourceRef: text("source_ref"),
    ownerUserId: uuid("owner_user_id"),
    createdBy: uuid("created_by"),
    createdAt: tstz("created_at").notNull().default(now()),
    updatedAt: tstz("updated_at").notNull().default(now()),
    deletedAt: tstz("deleted_at"),
  },
  (t) => [
    check("accounts_occupancy_pct_check", raw("occupancy_pct BETWEEN 0 AND 100")),
    check("accounts_fit_score_check", raw("fit_score BETWEEN 0 AND 100")),
    foreignKey({ name: fkey("accounts", "owner_user_id"), columns: [t.ownerUserId], foreignColumns: [users.id] }),
    foreignKey({ name: fkey("accounts", "created_by"), columns: [t.createdBy], foreignColumns: [users.id] }),
    index("accounts_owner_idx").on(t.ownerUserId).where(raw("deleted_at IS NULL")),
    index("accounts_name_trgm").using("gin", t.name.op("gin_trgm_ops")),
    index("accounts_city_type_idx").on(t.city, t.propertyType).where(raw("deleted_at IS NULL")),
    uniqueIndex("accounts_dedupe")
      .on(raw("lower(name)"), raw("lower(coalesce(city, ''))"))
      .where(raw("deleted_at IS NULL")),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    title: text("title"),
    email: citext("email"),
    phone: text("phone"),
    phoneType: phoneType("phone_type").notNull().default("unknown"),
    linkedinUrl: text("linkedin_url"),
    contactPref: text("contact_pref"),
    isPrimary: boolean("is_primary").notNull().default(false),
    emailStatus: contactEmailStatus("email_status").notNull().default("ok"),
    doNotCall: boolean("do_not_call").notNull().default(false),
    createdAt: tstz("created_at").notNull().default(now()),
    updatedAt: tstz("updated_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({
      name: fkey("contacts", "account_id"),
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    index("contacts_account_idx").on(t.accountId),
    index("contacts_email_idx").on(t.email),
    uniqueIndex("contacts_one_primary").on(t.accountId).where(raw("is_primary")),
  ],
);

// ───────── research ─────────
export const researchSources = pgTable(
  "research_sources",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    kind: sourceKind("kind").notNull(),
    url: text("url"),
    title: text("title"),
    contentText: text("content_text").notNull(),
    contentHash: text("content_hash").notNull(),
    fetchedAt: tstz("fetched_at").notNull().default(now()),
    addedBy: uuid("added_by"),
  },
  (t) => [
    foreignKey({
      name: fkey("research_sources", "account_id"),
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("research_sources", "added_by"), columns: [t.addedBy], foreignColumns: [users.id] }),
    unique("research_sources_account_id_content_hash_key").on(t.accountId, t.contentHash),
  ],
);

export const signals = pgTable(
  "signals",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    text: text("text").notNull(),
    kind: text("kind").notNull().default("other"),
    sourceId: uuid("source_id"),
    observedOn: date("observed_on"),
    confirmed: boolean("confirmed").notNull().default(false),
    createdBy: uuid("created_by"),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    check("signals_kind_check", raw("kind IN ('incident', 'timing', 'tenant', 'growth', 'other')")),
    foreignKey({ name: fkey("signals", "account_id"), columns: [t.accountId], foreignColumns: [accounts.id] }).onDelete(
      "cascade",
    ),
    foreignKey({
      name: fkey("signals", "source_id"),
      columns: [t.sourceId],
      foreignColumns: [researchSources.id],
    }).onDelete("set null"),
    foreignKey({ name: fkey("signals", "created_by"), columns: [t.createdBy], foreignColumns: [users.id] }),
    index("signals_account_idx").on(t.accountId),
  ],
);

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: id(),
    userId: uuid("user_id"),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    ok: boolean("ok").notNull(),
    error: text("error"),
    request: jsonb("request").notNull(),
    response: jsonb("response"),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({ name: fkey("ai_calls", "user_id"), columns: [t.userId], foreignColumns: [users.id] }),
    index("ai_calls_user_time_idx").on(t.userId, t.createdAt.desc().nullsFirst()),
  ],
);

export const researchBriefs = pgTable(
  "research_briefs",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    version: integer("version").notNull(),
    sections: jsonb("sections").notNull(),
    recommendedPackage: jsonb("recommended_package").notNull(),
    aiCallId: uuid("ai_call_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({
      name: fkey("research_briefs", "account_id"),
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("research_briefs", "ai_call_id"), columns: [t.aiCallId], foreignColumns: [aiCalls.id] }),
    foreignKey({ name: fkey("research_briefs", "created_by"), columns: [t.createdBy], foreignColumns: [users.id] }),
    unique("research_briefs_account_id_version_key").on(t.accountId, t.version),
  ],
);

export const clientReferences = pgTable("client_references", {
  id: id(),
  labelNamed: text("label_named").notNull(),
  labelAnonymized: text("label_anonymized").notNull(),
  propertyTypes: text("property_types").array().notNull(),
  stats: jsonb("stats").$type<Record<string, number>>().notNull(),
  namedPermission: boolean("named_permission").notNull().default(false),
  active: boolean("active").notNull().default(true),
  updatedAt: tstz("updated_at").notNull().default(now()),
});

// ───────── deals ─────────
export const deals = pgTable(
  "deals",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    name: text("name").notNull(),
    stage: dealStage("stage").notNull().default("lead"),
    status: dealStatus("status").notNull().default("open"),
    stageChangedAt: tstz("stage_changed_at").notNull().default(now()),
    package: jsonb("package"),
    annualValueCents: bigint("annual_value_cents", { mode: "number" }).notNull().default(0),
    expectedClose: date("expected_close"),
    lostReason: text("lost_reason"),
    lastActivityAt: tstz("last_activity_at").notNull().default(now()),
    createdAt: tstz("created_at").notNull().default(now()),
    updatedAt: tstz("updated_at").notNull().default(now()),
  },
  (t) => [
    check("deals_annual_value_cents_check", raw("annual_value_cents >= 0")),
    check("deals_check", raw("(status = 'won') = (stage = 'won')")),
    check("deals_check1", raw("status <> 'lost' OR lost_reason IS NOT NULL")),
    foreignKey({ name: fkey("deals", "account_id"), columns: [t.accountId], foreignColumns: [accounts.id] }).onDelete(
      "cascade",
    ),
    foreignKey({ name: fkey("deals", "owner_user_id"), columns: [t.ownerUserId], foreignColumns: [users.id] }),
    index("deals_owner_status_idx").on(t.ownerUserId, t.status),
    index("deals_account_idx").on(t.accountId),
    uniqueIndex("deals_one_open_per_account").on(t.accountId).where(raw("status = 'open'")),
  ],
);

export const dealStageHistory = pgTable(
  "deal_stage_history",
  {
    id: id(),
    dealId: uuid("deal_id").notNull(),
    fromStage: dealStage("from_stage"),
    toStage: dealStage("to_stage").notNull(),
    changedBy: uuid("changed_by"),
    changedAt: tstz("changed_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({
      name: fkey("deal_stage_history", "deal_id"),
      columns: [t.dealId],
      foreignColumns: [deals.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("deal_stage_history", "changed_by"), columns: [t.changedBy], foreignColumns: [users.id] }),
    index("deal_stage_history_deal_idx").on(t.dealId, t.changedAt),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    userId: uuid("user_id"),
    type: activityType("type").notNull(),
    subject: text("subject"),
    body: text("body"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default(raw("'{}'")),
    occurredAt: tstz("occurred_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({
      name: fkey("activities", "account_id"),
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("activities", "deal_id"), columns: [t.dealId], foreignColumns: [deals.id] }).onDelete(
      "set null",
    ),
    foreignKey({
      name: fkey("activities", "contact_id"),
      columns: [t.contactId],
      foreignColumns: [contacts.id],
    }).onDelete("set null"),
    foreignKey({ name: fkey("activities", "user_id"), columns: [t.userId], foreignColumns: [users.id] }),
    index("activities_account_time_idx").on(t.accountId, t.occurredAt.desc().nullsFirst()),
    index("activities_deal_time_idx").on(t.dealId, t.occurredAt.desc().nullsFirst()),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").notNull(),
    accountId: uuid("account_id"),
    dealId: uuid("deal_id"),
    title: text("title").notNull(),
    dueAt: tstz("due_at"),
    doneAt: tstz("done_at"),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({ name: fkey("tasks", "owner_user_id"), columns: [t.ownerUserId], foreignColumns: [users.id] }),
    foreignKey({ name: fkey("tasks", "account_id"), columns: [t.accountId], foreignColumns: [accounts.id] }).onDelete(
      "cascade",
    ),
    foreignKey({ name: fkey("tasks", "deal_id"), columns: [t.dealId], foreignColumns: [deals.id] }).onDelete("cascade"),
    index("tasks_owner_open_idx").on(t.ownerUserId, t.dueAt).where(raw("done_at IS NULL")),
  ],
);

// ───────── outreach ─────────
export const outreachDrafts = pgTable(
  "outreach_drafts",
  {
    id: id(),
    accountId: uuid("account_id").notNull(),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id").notNull(),
    userId: uuid("user_id").notNull(),
    channel: outreachChannel("channel").notNull(),
    tone: text("tone").notNull().default("professional"),
    subject: text("subject"),
    body: text("body").notNull(),
    checks: jsonb("checks").notNull().default(raw("'[]'")),
    aiCallId: uuid("ai_call_id"),
    status: draftStatus("status").notNull().default("draft"),
    createdAt: tstz("created_at").notNull().default(now()),
    updatedAt: tstz("updated_at").notNull().default(now()),
  },
  (t) => [
    check("outreach_drafts_tone_check", raw("tone IN ('professional', 'friendly', 'direct')")),
    foreignKey({
      name: fkey("outreach_drafts", "account_id"),
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("outreach_drafts", "deal_id"), columns: [t.dealId], foreignColumns: [deals.id] }).onDelete(
      "set null",
    ),
    foreignKey({
      name: fkey("outreach_drafts", "contact_id"),
      columns: [t.contactId],
      foreignColumns: [contacts.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("outreach_drafts", "user_id"), columns: [t.userId], foreignColumns: [users.id] }),
    foreignKey({ name: fkey("outreach_drafts", "ai_call_id"), columns: [t.aiCallId], foreignColumns: [aiCalls.id] }),
    index("outreach_drafts_user_idx").on(t.userId, t.status),
  ],
);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: id(),
    draftId: uuid("draft_id").unique("email_messages_draft_id_key"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id").notNull(),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    direction: emailDirection("direction").notNull(),
    status: emailStatus("status").notNull(),
    provider: mailProvider("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    fromEmail: citext("from_email").notNull(),
    toEmail: citext("to_email").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    error: text("error"),
    aiClassification: text("ai_classification"),
    sentAt: tstz("sent_at"),
    receivedAt: tstz("received_at"),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    check(
      "email_messages_ai_classification_check",
      raw("ai_classification IN ('interested', 'not_now', 'not_interested', 'out_of_office', 'unsubscribe', 'other')"),
    ),
    foreignKey({
      name: fkey("email_messages", "draft_id"),
      columns: [t.draftId],
      foreignColumns: [outreachDrafts.id],
    }).onDelete("set null"),
    foreignKey({ name: fkey("email_messages", "user_id"), columns: [t.userId], foreignColumns: [users.id] }),
    foreignKey({
      name: fkey("email_messages", "account_id"),
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("email_messages", "deal_id"), columns: [t.dealId], foreignColumns: [deals.id] }).onDelete(
      "set null",
    ),
    foreignKey({
      name: fkey("email_messages", "contact_id"),
      columns: [t.contactId],
      foreignColumns: [contacts.id],
    }).onDelete("set null"),
    unique("email_messages_provider_provider_message_id_key").on(t.provider, t.providerMessageId),
    index("email_messages_thread_idx").on(t.provider, t.providerThreadId),
    index("email_messages_user_sent_idx").on(t.userId, t.sentAt).where(raw("direction = 'out'")),
  ],
);

export const suppressions = pgTable(
  "suppressions",
  {
    email: citext("email").primaryKey(),
    reason: suppressionReason("reason").notNull(),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [foreignKey({ name: fkey("suppressions", "created_by"), columns: [t.createdBy], foreignColumns: [users.id] })],
);

// ───────── meetings ─────────
export const meetings = pgTable(
  "meetings",
  {
    id: id(),
    accountId: uuid("account_id"),
    dealId: uuid("deal_id"),
    ownerUserId: uuid("owner_user_id").notNull(),
    contactIds: uuid("contact_ids").array().notNull().default(raw("'{}'")),
    title: text("title").notNull(),
    kind: meetingKind("kind").notNull().default("site_walk"),
    status: meetingStatus("status").notNull().default("scheduled"),
    startsAt: tstz("starts_at").notNull(),
    endsAt: tstz("ends_at").notNull(),
    locationText: text("location_text"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    provider: mailProvider("provider"),
    providerEventId: text("provider_event_id"),
    prepBrief: jsonb("prep_brief"),
    prepAiCallId: uuid("prep_ai_call_id"),
    createdAt: tstz("created_at").notNull().default(now()),
    updatedAt: tstz("updated_at").notNull().default(now()),
  },
  (t) => [
    check("meetings_check", raw("ends_at > starts_at")),
    foreignKey({
      name: fkey("meetings", "account_id"),
      columns: [t.accountId],
      foreignColumns: [accounts.id],
    }).onDelete("cascade"),
    foreignKey({ name: fkey("meetings", "deal_id"), columns: [t.dealId], foreignColumns: [deals.id] }).onDelete(
      "set null",
    ),
    foreignKey({ name: fkey("meetings", "owner_user_id"), columns: [t.ownerUserId], foreignColumns: [users.id] }),
    foreignKey({ name: fkey("meetings", "prep_ai_call_id"), columns: [t.prepAiCallId], foreignColumns: [aiCalls.id] }),
    index("meetings_owner_time_idx").on(t.ownerUserId, t.startsAt),
  ],
);

// ───────── pricing, proposals, contracts ─────────
export const pricingConfigs = pgTable(
  "pricing_configs",
  {
    id: id(),
    effectiveFrom: date("effective_from").notNull().unique("pricing_configs_effective_from_key"),
    hourlyRateCents: jsonb("hourly_rate_cents").$type<{ unarmed: number; armed: number }>().notNull(),
    coverageHoursPerWeek: jsonb("coverage_hours_per_week")
      .$type<{ "24_7": number; nights: number; business_hours: number }>()
      .notNull(),
    supervisorMultiplier: numeric("supervisor_multiplier", { precision: 5, scale: 4 }).notNull().default(raw("1.05")),
    addons: jsonb("addons").$type<Record<string, { label: string; monthlyCents: number }>>().notNull(),
    termDiscounts: jsonb("term_discounts").$type<Record<string, number>>().notNull(),
    maxManualDiscount: numeric("max_manual_discount", { precision: 5, scale: 4 }).notNull().default(raw("0.10")),
    createdBy: uuid("created_by"),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({ name: fkey("pricing_configs", "created_by"), columns: [t.createdBy], foreignColumns: [users.id] }),
  ],
);

export const proposals = pgTable(
  "proposals",
  {
    id: id(),
    dealId: uuid("deal_id").notNull(),
    version: integer("version").notNull(),
    status: proposalStatus("status").notNull().default("draft"),
    package: jsonb("package").notNull(),
    pricing: jsonb("pricing").notNull(),
    manualDiscount: numeric("manual_discount", { precision: 5, scale: 4 }).notNull().default(raw("0")),
    discountApprovedBy: uuid("discount_approved_by"),
    coverNote: text("cover_note"),
    pdfObjectKey: text("pdf_object_key"),
    publicTokenHash: text("public_token_hash").unique("proposals_public_token_hash_key"),
    sentAt: tstz("sent_at"),
    expiresAt: tstz("expires_at"),
    createdBy: uuid("created_by").notNull(),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    check("proposals_manual_discount_check", raw("manual_discount >= 0 AND manual_discount < 1")),
    foreignKey({ name: fkey("proposals", "deal_id"), columns: [t.dealId], foreignColumns: [deals.id] }).onDelete(
      "cascade",
    ),
    foreignKey({
      name: fkey("proposals", "discount_approved_by"),
      columns: [t.discountApprovedBy],
      foreignColumns: [users.id],
    }),
    foreignKey({ name: fkey("proposals", "created_by"), columns: [t.createdBy], foreignColumns: [users.id] }),
    unique("proposals_deal_id_version_key").on(t.dealId, t.version),
  ],
);

export const proposalViews = pgTable(
  "proposal_views",
  {
    id: id(),
    proposalId: uuid("proposal_id").notNull(),
    viewedAt: tstz("viewed_at").notNull().default(now()),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
  },
  (t) => [
    foreignKey({
      name: fkey("proposal_views", "proposal_id"),
      columns: [t.proposalId],
      foreignColumns: [proposals.id],
    }).onDelete("cascade"),
    index("proposal_views_proposal_idx").on(t.proposalId, t.viewedAt),
  ],
);

export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    dealId: uuid("deal_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    status: contractStatus("status").notNull().default("draft"),
    esignProvider: text("esign_provider").notNull(),
    providerEnvelopeId: text("provider_envelope_id").unique("contracts_provider_envelope_id_key"),
    signerContactId: uuid("signer_contact_id"),
    viewCount: integer("view_count").notNull().default(0),
    sentAt: tstz("sent_at"),
    signedAt: tstz("signed_at"),
    signedPdfObjectKey: text("signed_pdf_object_key"),
    createdBy: uuid("created_by").notNull(),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({ name: fkey("contracts", "deal_id"), columns: [t.dealId], foreignColumns: [deals.id] }).onDelete(
      "cascade",
    ),
    foreignKey({ name: fkey("contracts", "proposal_id"), columns: [t.proposalId], foreignColumns: [proposals.id] }),
    foreignKey({
      name: fkey("contracts", "signer_contact_id"),
      columns: [t.signerContactId],
      foreignColumns: [contacts.id] as [AnyPgColumn],
    }).onDelete("set null"),
    foreignKey({ name: fkey("contracts", "created_by"), columns: [t.createdBy], foreignColumns: [users.id] }),
    index("contracts_deal_idx").on(t.dealId),
  ],
);

// ───────── imports and audit ─────────
export const imports = pgTable(
  "imports",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    filename: text("filename").notNull(),
    objectKey: text("object_key").notNull(),
    status: text("status").notNull().default("uploaded"),
    columnMap: jsonb("column_map"),
    rowsTotal: integer("rows_total"),
    rowsCreated: integer("rows_created"),
    rowsSkipped: integer("rows_skipped"),
    errors: jsonb("errors").notNull().default(raw("'[]'")),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    check("imports_status_check", raw("status IN ('uploaded', 'previewed', 'running', 'done', 'failed')")),
    foreignKey({ name: fkey("imports", "user_id"), columns: [t.userId], foreignColumns: [users.id] }),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default(raw("'{}'")),
    ip: inet("ip"),
    createdAt: tstz("created_at").notNull().default(now()),
  },
  (t) => [
    foreignKey({ name: fkey("audit_log", "user_id"), columns: [t.userId], foreignColumns: [users.id] }),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_time_idx").on(t.createdAt.desc().nullsFirst()),
  ],
);
