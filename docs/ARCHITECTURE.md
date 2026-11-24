# Security Of America Sales CRM: Architecture

This is the build specification. Where this document and the demo in `reference/sales-demo.jsx` disagree, this document wins. The demo shows the intended screens and wording; its AI and data are simulated.

## 1. What we are building

A private web app for 5 account executives (AEs) and their sales manager at a security guard company. It covers one job end to end: find a property that needs security, research it, reach the decision maker, book a site walk, send a proposal, get the contract signed.

**In scope for version 1**

| # | Capability | Summary |
|---|---|---|
| 1 | Sign-in | Company single sign-on (Microsoft 365 or Google Workspace). No passwords stored in the CRM. |
| 2 | Accounts, contacts, deals | CRUD, CSV import with dedupe, 7-stage pipeline, activity timeline, tasks, notes. |
| 3 | Prospect finder | Search and filter the account database; fit score with reasons; claim unassigned accounts. |
| 4 | AI research brief | 8-section brief built only from stored sources, each fact cited. |
| 5 | AI outreach | Email, call script, voicemail and LinkedIn note drafts; compliance checks; email sent from the rep's own mailbox after they click Send. |
| 6 | Reply tracking | Replies and bounces on CRM-sent threads appear on the timeline; unsubscribes are honoured company-wide. |
| 7 | Meetings | Reads the rep's real calendar, proposes 3 times that allow for drive time, books and sends the invite, writes a prep brief. |
| 8 | Proposals | Pricing calculator, PDF proposal, share link with view tracking. |
| 9 | Contracts | E-signature; a signed contract moves the deal to Won automatically. |
| 10 | Today and pipeline | Next-best-action list, weekly calendar, pipeline board, weighted forecast. |
| 11 | Ask Sales AI | Question box that answers from CRM data through fixed read-only queries. |
| 12 | Admin | Users and roles, pricing, client references, suppression list, audit log, CSV export. |

**Out of scope for version 1** (do not build): automated email sequences or any send without a click, open-tracking pixels, a phone dialer or SMS, a mobile app, buying prospect lists inside the app, access to guard locations or incident data, multi-company tenancy.

**Scale targets:** 6 to 10 users, up to 50,000 accounts, 200,000 activities. One region, one database. Do not add queues, caches or services beyond what is listed here.

## 2. Technology choices (fixed)

| Layer | Choice |
|---|---|
| Language | TypeScript 5, strict mode, everywhere |
| Monorepo | pnpm workspaces |
| Web | React 19, Vite, React Router, TanStack Query, Tailwind CSS 4, lucide-react |
| API | Node.js 22, Fastify 5, Zod for every request and response |
| Database | PostgreSQL 16, Drizzle ORM and drizzle-kit migrations |
| Background jobs | pg-boss (uses Postgres; no Redis) |
| AI | Claude models through Amazon Bedrock (Converse API) in the company's own AWS account, reached over a VPC endpoint |
| Files | S3 (MinIO in local development) |
| PDF | Playwright Chromium rendering an HTML template, in the worker |
| Tests | Vitest (unit, API integration against a real Postgres), Playwright (end to end) |
| Hosting | AWS: ECS Fargate (api, worker), RDS PostgreSQL, S3, ALB, Secrets Manager; Terraform |
| Local dev | Docker Compose: postgres, minio, mailpit; fake providers for mail, calendar, AI, maps, e-sign |

Swappable pieces sit behind an interface with one real adapter and one fake adapter for tests: `MailProvider`, `CalendarProvider`, `AiClient`, `MapsProvider`, `ESignProvider`, `ObjectStore`. Open choices (which mail system, which e-sign vendor) are listed in `DECISIONS.md`; build only the adapter for the chosen one plus the fake.

## 3. System layout

```
Browser (reps, manager)                       Prospects (public internet)
        │ HTTPS, session cookie                       │ HTTPS, signed token in URL
        ▼                                             ▼
┌─────────────────────────── Application Load Balancer ───────────────────────────┐
│  /app, /api/*  → allowed only from office/VPN IP ranges                          │
│  /p/*, /u/*, /webhooks/*  → open to the internet (public surface, §10.3)         │
└──────────────────────────────────────┬───────────────────────────────────────────┘
                                       ▼
                    api service (Fastify; also serves the built web app)
                       │            │                │
                       ▼            ▼                ▼
                 PostgreSQL      S3 bucket      pg-boss queue (in Postgres)
                       ▲            ▲                │
                       │            │                ▼
                       └────── worker service ───────┘
                                    │  outbound only, through NAT / VPC endpoints
        ┌──────────────┬────────────┼───────────────┬────────────────┐
        ▼              ▼            ▼               ▼                ▼
   Bedrock (AI)   Mail + Calendar   Maps API    E-sign API     Prospect websites
   VPC endpoint   (Graph or Google)                             (research fetch)
```

### Repository layout

```
apps/
  web/        React app (screens in §12)
  api/        Fastify server: routes/, services/, repos/, providers/, auth/
  worker/     pg-boss handlers: jobs/
packages/
  shared/     Zod schemas, types, pricing engine, stage rules, next-best-action rules, slot finder (pure functions)
  db/         Drizzle schema, migrations, seed
infra/        Terraform
docs/         this kit
reference/    demo source (read-only)
```

Rules of the layout:
- `packages/shared` has no I/O. Pricing, stage rules, next-best-action rules and the slot finder live there as pure functions with unit tests.
- Routes call services; services call repos and providers. Routes never touch Drizzle directly.
- Only `apps/api/src/providers/ai/` and `apps/worker` may import the Bedrock SDK.

## 4. Roles and visibility

| Role | Can do |
|---|---|
| `ae` | Everything on accounts and deals they own; see and claim unassigned accounts; see company suppression list (read only). |
| `manager` | Everything an AE can do, on every account and deal; reassign owners; approve discounts; edit pricing and client references; export. |
| `admin` | Manager rights plus user management and the audit log. |

Visibility rule, enforced in the repo layer and nowhere else:

```
visible(account, user) = user.role in (manager, admin)
                         OR account.owner_user_id = user.id
                         OR account.owner_user_id IS NULL
```

Deals, contacts, signals, sources, briefs, drafts, emails, meetings, proposals, contracts and activities inherit visibility from their account (deals additionally require `deal.owner_user_id = user.id` for AEs to edit). Every repo function takes a `Scope` argument (`{ userId, role }`) as its first parameter; there is no unscoped variant exported. A request for a row the user cannot see returns 404, not 403.

Required test: one integration test file iterates every registered `/api` route with a second AE's session and asserts 404 or an empty list for the first AE's data. Adding a route without adding it to that test fails CI.

## 5. Data model

`docs/DATA_MODEL.sql` is the schema (24 tables, verified to load on PostgreSQL 16). Implement it as a Drizzle schema whose generated migration matches it. Key points:

- **Account** is the property or company being pursued. `owner_user_id` NULL means the shared pool.
- **Deal**: at most one open deal per account. `stage` and `status` are consistent by constraint.
- **Activities** are the timeline. Services write an activity in the same transaction as the change it describes.
- **research_sources** holds every piece of text the AI may cite. AI output that cites an unknown source id is rejected.
- **suppressions** is company-wide and checked inside the send transaction.
- **email_messages.draft_id is UNIQUE**, which makes a double send of one draft impossible.
- **pricing_configs** is versioned; proposals store a snapshot of the numbers they used.
- **audit_log** is append-only; the app's database role has no UPDATE or DELETE on it.

### Deal stages

| Stage | Win probability | Entered when |
|---|---|---|
| `lead` | 0.05 | Deal created |
| `researched` | 0.10 | First research brief saved |
| `contacted` | 0.20 | First outbound email sent or call/voicemail/LinkedIn logged |
| `meeting_set` | 0.35 | First customer meeting booked |
| `proposal` | 0.55 | First proposal sent |
| `contract_sent` | 0.80 | Contract sent for signature |
| `won` | 1.00 | Signature webhook says completed (or manager marks won with a reason) |

Automatic moves only go forward and never skip past the next trigger. A rep can move a deal manually to any stage up to `proposal`; `contract_sent` and `won` are set by the system (a manager can override, audited). Marking a deal lost requires a reason from a fixed list plus optional text. Every change writes `deal_stage_history` and an activity. Weighted forecast = Σ `annual_value_cents × probability` over open deals.

## 6. Pricing engine (`packages/shared/pricing.ts`)

```ts
type Package = {
  posts: number;                               // 0..20 guard posts
  armed: boolean;
  coverage: "24_7" | "nights" | "business_hours";
  supervisor: boolean;                         // adds a site supervisor uplift
  addons: Array<"patrol" | "video" | "portal">;
  termMonths: 12 | 24 | 36;
};

type PriceBreakdown = {
  pricingConfigId: string;
  hoursPerWeek: number;        // posts × coverageHours[coverage]
  hourlyRateCents: number;     // rate[armed ? "armed" : "unarmed"] × (supervisor ? supervisorMultiplier : 1), rounded to the cent
  addonsMonthlyCents: number;  // Σ addons[k].monthlyCents
  termDiscount: number;        // termDiscounts[termMonths]
  manualDiscount: number;      // 0..1, default 0
  annualCents: number;         // round((hoursPerWeek × hourlyRateCents × 52 + addonsMonthlyCents × 12) × (1 − termDiscount) × (1 − manualDiscount))
  monthlyCents: number;        // round(annualCents / 12)
};
```

Seed pricing (editable by a manager under Admin; values come from the demo and must be confirmed, see `DECISIONS.md`):

| Item | Value |
|---|---|
| Unarmed hourly rate | $29.00 |
| Armed hourly rate | $38.00 |
| Supervisor multiplier | 1.05 |
| Coverage hours per week | 24/7 = 168, nights (6 pm to 6 am) = 84, business hours (Mon to Fri) = 60 |
| Mobile patrol, 3 visits a night | $1,450 a month |
| Remote video monitoring | $2,200 a month |
| Client portal with live officer map | $0 |
| Term discount | 12 months 0%, 24 months 3%, 36 months 5% |
| Manual discount needing manager approval | above 10% |

Reference case for the unit test: 2 unarmed posts, 24/7, no supervisor, add-on `video`, 36 months, no manual discount → hours 336, annual = (336 × 2900 × 52 + 220000 × 12) × 0.95 = 50,643,360 cents ($506,433.60), monthly 4,220,280 cents.

All money is integer cents in code and storage. The server recomputes every price; a price sent by the browser is ignored.

## 7. AI layer

### 7.1 Client

One module, `apps/api/src/providers/ai/client.ts`, exposes:

```ts
ai.generate<T>({ feature, tier: "writer" | "fast", system, messages, schema: ZodType<T>, userId }): Promise<{ data: T; aiCallId: string }>
```

- Calls Bedrock Converse with a single forced tool whose input schema is generated from `schema`; the tool input is the result. Validate with Zod; on a validation failure retry once with the error appended; then fail with a typed error.
- Model ids come from `AI_MODEL_WRITER` and `AI_MODEL_FAST`. Recommended: Claude Sonnet for writer, Claude Haiku for fast (confirm what is enabled in the account, `DECISIONS.md`).
- Every call writes an `ai_calls` row (feature, model, tokens, latency, request, response). A nightly job nulls `request` and `response` after 90 days.
- Timeouts: 60 s writer, 20 s fast. Per-user limit: 200 AI calls a day (429 with a clear message).
- The model is never given tools that change data. It returns text and structured data; application code decides what to do with it.

### 7.2 Rules for every AI feature

1. **Grounded.** Prompts contain only data from the database, passed in clearly delimited blocks. Outputs that state facts carry `sourceIds`; the server rejects ids that are not in the input.
2. **Untrusted text.** Website content, inbound email and CSV text are wrapped as `<untrusted_source id="…">…</untrusted_source>` with a system instruction that their content is data, never instructions.
3. **Human in the loop.** AI drafts; a person edits and clicks. No AI output is sent, booked or saved as fact without a user action. AI-extracted signals are stored with `confirmed = false` and shown as "unconfirmed" until a rep confirms them.
4. **No invented specifics.** If a section has no supporting data, the model must return the fixed string for "not enough information" and the UI shows a prompt to add a source.
5. **Deterministic checks in code.** Compliance checks that can be done with code are done with code (§8.3), not by asking the model.
6. **Evaluated.** Each feature has a fixtures folder (`apps/api/test/ai-fixtures/<feature>/`) with 5 or more input cases and assertions on structure and rules (cites only given sources, includes required elements, stays under length). These run against the real model with `pnpm test:ai` (not in normal CI) and against recorded responses in CI.

### 7.3 Features

| Feature | Tier | Input | Output |
|---|---|---|---|
| `signal_extract` | fast | One research source | `[{ text, kind, observedOn?, quote }]`; `quote` must be an exact substring of the source or the signal is dropped |
| `research_brief` | writer | Account, contacts, signals, sources, matching client reference, pricing table | 8 sections (below) plus a recommended `Package` |
| `outreach_draft` | writer | Account, contact, deal stage, channel, tone, top signals, anonymized reference, up to 2 proposed meeting times, rep name/title/phone | `{ subject, body }` without the footer (code adds it) |
| `claim_check` | fast | A draft | `{ absoluteClaims: string[], disparagement: string[] }` as advisory flags |
| `reply_classify` | fast | An inbound reply | One of `interested, not_now, not_interested, out_of_office, unsubscribe, other`, plus a one-line summary |
| `prep_brief` | writer | Account, contacts, signals, latest brief, deal, meeting, drive time | 6 sections (below) |
| `ask` | writer | Question, results of the fixed queries (§11) | `{ answer, items: [{ label, sub, link }] }` |

**Research brief sections** (keys fixed): `overview`, `decision_makers`, `security_signals`, `current_coverage_and_timing`, `recommended_package`, `proof_point_internal`, `talking_points`, `likely_objections`. The recommended package is priced by the pricing engine after the model returns it, and the server writes the price sentence, not the model.

**Prep brief sections:** `goal`, `who_you_are_meeting`, `agenda`, `questions_to_ask`, `bring`, `logistics`. `logistics` is written by code from the meeting and drive time.

**Fit score** is code, not AI (`packages/shared/fit.ts`), 0 to 100 with reasons: +30 a confirmed incident signal in the last 180 days; +25 contract end date within 120 days; +20 no professional provider today (`None`, `In-house`, cameras only); +15 estimated annual value of the default package for the property type ≥ $400,000; +10 has a primary contact with an email. Recomputed when the inputs change.

## 8. Outreach

### 8.1 Channels

| Channel | What the CRM does |
|---|---|
| Email | Drafts, checks, sends through the rep's mailbox, tracks replies |
| Call | Shows a script; rep logs the outcome (connected, left voicemail, no answer, wrong number) |
| Voicemail | Shows a 20-second script; rep logs it |
| LinkedIn | Shows a note under 300 characters with a copy button; rep logs it. No automation of LinkedIn. |

### 8.2 Sending email

`POST /api/drafts/:id/send` is the only code path that sends email. In one database transaction it:

1. Loads the draft with the caller's scope; requires `status = 'draft'`, `channel = 'email'`.
2. Re-runs all checks (§8.3) on the stored body. Any failed blocking check → 422 with the list.
3. Checks the rep's sends in the last 24 hours against `users.daily_send_cap` → 429 if reached.
4. Inserts `email_messages` (`status = 'queued'`; the UNIQUE `draft_id` stops a double send), sets the draft to `sent`, writes the activity and the audit row, advances the deal stage if it applies.
5. Enqueues `mail.send` with the message id.

The worker sends through `MailProvider.send` using the rep's token, stores `provider_message_id` and `provider_thread_id`, and sets `sent`. On a permanent error it sets `failed`, reverts nothing, and shows the failure on the timeline with a Retry button (which re-enqueues the same message row). No job other than `mail.send` calls `MailProvider.send`, and `mail.send` only accepts an id of a `queued` row created by the route above. There is no bulk send endpoint.

The footer is appended by code at send time and shown in the editor as a locked block:

```
{rep name}
{rep title}, Security Of America
{rep phone}

Security Of America · {COMPANY_POSTAL_ADDRESS} · Unsubscribe: {PUBLIC_URL}/u/{token}
```

The unsubscribe token is `base64url(contactEmail) + "." + HMAC-SHA256(contactEmail, UNSUBSCRIBE_SECRET)`; no table is needed.

### 8.3 Checks (code, run on every edit and again at send)

| Id | Rule | Blocking |
|---|---|---|
| `recipient_ok` | Contact has an email; not in `suppressions`; contact `email_status = 'ok'`; account not `do_not_contact` | Yes |
| `footer` | Postal address and unsubscribe link present (always true because code adds them; fails if `COMPANY_POSTAL_ADDRESS` is unset) | Yes |
| `no_named_client` | Body and subject contain no `client_references.label_named` where `named_permission = false` (case-insensitive, whole phrase) | Yes |
| `subject_present` | Subject is 1 to 120 characters, not all capitals, and has no "Re:" or "Fwd:" unless the draft is a reply in an existing thread | Yes |
| `length` | Email body ≤ 1,200 characters; LinkedIn note ≤ 300 | Yes for LinkedIn, warning for email |
| `phone_ok` (call, voicemail) | Contact `do_not_call = false`; if `phone_type = 'mobile'` show a warning to dial by hand | Yes for do-not-call |
| `claims` | `claim_check` found absolute claims ("guarantee", "100%") or disparagement of the incumbent | Warning |

### 8.4 Replies, bounces, unsubscribes

- Job `mail.sync` runs every 2 minutes per connected user. It asks the provider for new messages since `mail_sync_cursor` and keeps **only** messages whose thread id matches an `email_messages` row sent from the CRM. Other mail is never stored or sent to the AI.
- A matched inbound message is stored (`direction = 'in'`), classified with `reply_classify`, and added to the timeline. `interested` creates a task "Reply to {name}" due today.
- A delivery failure notice on a CRM thread marks the message `bounced`, sets the contact to `bounced` and adds a suppression.
- `GET /u/:token` shows a one-button confirm page; `POST /u/:token` adds the suppression and marks the contact `unsubscribed`. A reply classified `unsubscribe` does the same and tells the rep.
- If a token refresh fails, set `needs_reconnect`, stop syncing that user, and show a banner asking them to reconnect.

## 9. Meetings

### 9.1 Finding times (`packages/shared/slots.ts`, pure)

Inputs: the rep's busy events for the next 10 business days (from `CalendarProvider.listEvents`, each with start, end and optional location coordinates), the rep's base location and working hours, the account's coordinates, the meeting length (default 60 minutes for a site walk, 30 for a call), contact preference text, a `driveMinutes(from, to)` function, and the current time.

Algorithm:
1. Candidate starts on a 30-minute grid inside working hours, Monday to Friday, at least 2 hours from now.
2. Drop candidates that overlap a busy event.
3. `driveIn` = drive time from the previous event that day with a location (or the base location) to the account. Drop if previous end + `driveIn` > start. Phone and video meetings need no drive time and are treated as located at the base.
4. `driveOut` = drive time to the next located event. Drop if end + `driveOut` > next start.
5. Score = 100 − 6 × (business days from today) − `driveIn`/3 − `driveOut`/3; +15 if it matches a stated morning or afternoon preference, −10 if it conflicts.
6. Return the top 3, at most one per day, in date order, each with reasons ("18 min drive from the office", "clear before your 3:00 pm review").

`MapsProvider.driveMinutes` calls the maps API with departure time and caches results in memory for 24 hours keyed by rounded coordinates and hour. If the maps API fails, fall back to straight-line distance × 1.4 at 30 mph plus 8 minutes and label the slot "estimated".

### 9.2 Booking

`POST /api/meetings` re-checks that the slot is still free, creates the calendar event through `CalendarProvider.createEvent` with the contact as an attendee (the mail system sends the invite), stores the meeting with `provider_event_id`, writes the activity, moves the deal to `meeting_set`, and enqueues `prep.generate`. Job `calendar.sync` (every 5 minutes) updates or cancels CRM meetings when the calendar event changes. Reps mark the outcome (done, no-show, cancelled) afterwards.

## 10. Proposals, contracts and the public surface

### 10.1 Proposals

- The builder edits a `Package`; the price panel updates through `POST /api/pricing/quote`.
- A manual discount above `max_manual_discount` puts the proposal in "needs approval"; a manager approves in the app.
- "Generate" enqueues `proposal.render`: the worker renders `templates/proposal.html` (cover note, scope of service, price table, start plan, terms summary, rep contact) to PDF and stores it in S3.
- "Send" creates a share token (32 random bytes, stored as a SHA-256 hash), sets expiry 30 days out, and creates an email draft with the link for the rep to review and send through the normal send path.
- The public page `/p/:token` shows the PDF and a "Contact {rep}" link. Each load records a `proposal_views` row (IP stored only as a salted hash) and, for the first view per day, an activity `proposal_viewed`.

### 10.2 Contracts

- "Send contract" is enabled on a sent proposal. It fills the service agreement template (a PDF template supplied by the company, see `DECISIONS.md`) with party names, the package, price, term and start date, and creates an envelope through `ESignProvider.createEnvelope` with the chosen contact as signer and the company signer second.
- The webhook `/webhooks/esign` verifies the provider's signature, then updates the contract: `viewed` increments `view_count`; `signed` stores the signed PDF in S3, sets `signed_at`, moves the deal to `won`, writes activities, and creates a task "Hand off to operations".
- `declined` and `voided` are recorded and create a task for the rep.

### 10.3 Public surface

Only these routes are reachable from the internet. They share nothing with the session system and are rate limited (30 requests a minute per IP):

| Route | Purpose |
|---|---|
| `GET /p/:token` | View a proposal |
| `GET, POST /u/:token` | Unsubscribe |
| `POST /webhooks/esign` | E-signature events (signature verified) |
| `GET /healthz` | Load balancer health check |

## 11. Today view, next best actions and Ask Sales AI

### 11.1 Next best actions (`packages/shared/nba.ts`, pure, no AI)

Computed per rep on request, sorted by priority then value:

| Priority | Condition | Text and button |
|---|---|---|
| 0 | Customer meeting today after now, or on the next business day | "{title} {today/tomorrow} at {time}. Your prep brief is ready." → Open prep brief |
| 1 | Reply classified `interested` with no outbound since | "{contact} replied and sounds interested." → Reply |
| 1 | Stage `contract_sent`, `view_count ≥ 1`, sent ≥ 2 days ago | "{contact} viewed the contract {n} times but hasn't signed." → Draft nudge |
| 2 | Stage `proposal`, proposal viewed ≥ 2 times, no activity for 2 days | "{contact} has opened the proposal {n} times." → Open call script |
| 2 | Stage `proposal`, no reply for ≥ 5 days | "Proposal sent {n} days ago with no reply." → Draft follow-up |
| 3 | Stage `contacted`, no reply for ≥ 4 days, fewer than 3 touches | "No reply from {contact} in {n} days." → Draft follow-up |
| 3 | Stage `researched`, no outreach | "{account} is researched but not contacted. Lead with: {top signal}." → Start outreach |
| 4 | Stage `lead` | "{account} needs research before outreach." → Research |
| 4 | Task due today or overdue | Task title → Open |

The Today screen also shows four numbers (open pipeline, weighted forecast, customer meetings this week, won this quarter) and today's calendar. From Friday 3 pm through Sunday, the calendar panel shows next week.

### 11.2 Ask Sales AI

The server, not the model, runs queries. A fixed set of read-only, scoped query functions exists: `myOpenDeals`, `dealsByStage`, `stalledDeals(days)`, `meetingsBetween(from, to)`, `accountByName(text)`, `recentReplies(days)`, `topAccountsByFit(n, filters)`, `forecast`. Step 1: the fast model picks which functions to call and with what arguments (structured output, validated). Step 2: the server runs them under the caller's scope. Step 3: the writer model answers using only those results. If the question asks to draft something for a named account, the answer links to the outreach screen for that account instead of drafting inline.

## 12. Screens

All screens follow the demo's dark zinc style: emerald for good states, amber for pending, blue for AI, red for errors. The sales portion of the demo is the visual reference.

| Route | Screen | Contents |
|---|---|---|
| `/login` | Sign in | One button: "Sign in with Microsoft" (or Google) |
| `/` | Today | Stats, next best actions, today's schedule, week calendar |
| `/prospects` | Prospect finder | Search box, filters (city, property type, fit score, owner: mine / unassigned / all for managers), results table with fit reasons, Claim, Add account, Import CSV |
| `/pipeline` | Pipeline | Board by stage with value totals, drag to move (within allowed stages), list view, forecast; manager can filter by rep |
| `/accounts/:id` | Account | Header (name, stage selector, value, owner) and tabs: Research, Outreach, Meetings, Proposal, Contract, Timeline; contacts panel; tasks panel |
| `/calendar` | Calendar | Two-week view of CRM meetings and busy blocks |
| `/ask` | Ask Sales AI | Also opens with Ctrl/⌘+K from anywhere |
| `/admin/*` | Admin (manager, admin) | Users, pricing, client references, suppression list, imports, audit log (admin), export |
| `/settings` | My settings | Time zone, base address, working hours, phone, mail connection status and Reconnect |

Every AI action shows a loading state, the result with sources where applicable, and Regenerate. Every list has an empty state that says what to do next. Every failed request shows what failed and a retry. The app must work at 1280 px wide and be usable on a 390 px phone for Today, Account and Calendar.

## 13. API

JSON over HTTPS under `/api`. Cookie session. All request bodies and responses are Zod schemas in `packages/shared/api.ts`, used by both server and web. Errors: `{ error: { code, message, details? } }` with 400, 401, 404, 409, 422, 429. Lists use `?cursor=&limit=` (max 100). State-changing requests require the `X-CSRF-Token` header (double-submit cookie). The full list is in `docs/API.md`.

## 14. Background jobs (pg-boss)

| Job | Trigger | Does | Retries |
|---|---|---|---|
| `mail.send` | Send route | Sends one queued message | 3, exponential; permanent errors fail immediately |
| `mail.sync` | Every 2 min per user | Replies and bounces on CRM threads | Next tick |
| `calendar.sync` | Every 5 min per user | Reflects calendar changes in meetings | Next tick |
| `research.fetch` | "Add website" or "Research" | Fetches up to 8 pages from the account's website (same host only, obeys robots.txt, 10 s timeout, 1 MB cap, text extracted), stores sources, runs `signal_extract` | 2 |
| `research.brief` | Rep clicks Generate | Builds the brief | 1 |
| `prep.generate` | Meeting booked, and again at 6 am on the meeting day | Builds the prep brief | 1 |
| `proposal.render` | Generate proposal | PDF to S3 | 2 |
| `import.run` | Import confirmed | Creates accounts and contacts from CSV | 0 (resumable by row) |
| `fit.recompute` | Signals, contacts or contract date changed | Updates fit score | 1 |
| `maintenance.nightly` | 3 am | Purge old AI payloads, expire sessions and proposals, verify last backup | 1 |

`research.fetch` blocks private and link-local IP ranges after DNS resolution and follows at most 3 redirects, re-checking each hop.

## 15. Sign-in, sessions and security

- **Sign-in:** OpenID Connect authorization code flow with PKCE against the company's Microsoft Entra ID tenant or Google Workspace. Only addresses in `ALLOWED_EMAIL_DOMAIN` that match an active `users` row may sign in (an admin adds users first; the first admin comes from `BOOTSTRAP_ADMIN_EMAIL`). Multi-factor authentication is enforced by the identity provider.
- **Mail and calendar permission** is granted in the same consent. Microsoft scopes: `openid profile email offline_access User.Read Mail.Send Mail.Read Calendars.ReadWrite`. Google scopes: `openid email profile`, `gmail.send`, `gmail.readonly`, `calendar.events`, `calendar.readonly`.
- **Tokens** are encrypted with AES-256-GCM using a key from Secrets Manager before storage, and never logged or returned by the API.
- **Sessions:** 256-bit random value in a `Secure; HttpOnly; SameSite=Lax` cookie; only its hash is stored; 12-hour idle timeout, 7-day maximum; sign-out deletes the row.
- **Headers:** strict Content-Security-Policy (no inline script), HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`.
- **Input:** Zod on every route; Drizzle parameterized queries only; file uploads limited to CSV up to 10 MB, parsed in the worker.
- **Rate limits:** 300 requests a minute per session on `/api`; AI and send limits as above.
- **Secrets:** only in Secrets Manager and local `.env` (git-ignored). Startup fails if a required variable is missing.
- **Network:** RDS and the services sit in private subnets. The load balancer restricts `/app` and `/api` to office and VPN IP ranges. Bedrock and S3 are reached through VPC endpoints.
- **Audit:** sign-in, sign-out, every send, stage change, owner change, export, pricing change, user change, discount approval and suppression change writes `audit_log`.
- **Logging:** structured JSON; never log email bodies, tokens or prompt contents.
- **Data lifecycle:** deleting an account soft-deletes it; a manager can purge an account (hard delete with cascade, audited). "Delete contact data" removes a contact's personal fields and keeps the suppression.

## 16. Environments, deployment and operations

| Environment | Purpose | Providers |
|---|---|---|
| Local | Development | Docker Compose; all external providers faked; `pnpm dev` |
| Staging | Pilot rehearsal | Real AWS stack, real sign-in, real mail to an allow-list of internal addresses only (`MAIL_ALLOWLIST`) |
| Production | The 5 AEs | Real everything |

- **Terraform** (`infra/`): VPC with two private and two public subnets, ALB with an ACM certificate, ECS Fargate services `api` (2 tasks, 0.5 vCPU / 1 GB) and `worker` (1 task, 1 vCPU / 2 GB for Chromium), RDS PostgreSQL 16 `db.t4g.small` Multi-AZ with 14-day point-in-time recovery, S3 bucket with versioning and encryption, Secrets Manager, VPC endpoints for Bedrock runtime and S3, CloudWatch log groups and alarms.
- **CI (GitHub Actions):** typecheck, lint, unit tests, integration tests against a Postgres service container, Playwright end-to-end against the local stack with fakes, build images. Merges to `main` deploy to staging; a manual approval deploys to production. Migrations run as a one-off task before the new version starts and must be backward compatible with the running version.
- **Monitoring:** `/healthz` (process up) and `/readyz` (database reachable). Alarms: 5xx rate, p95 latency over 2 s, job failures, queue age over 10 minutes, any `needs_reconnect`, RDS storage and CPU. Alarms go to an email list.
- **Backups:** RDS automated backups plus a weekly restore test into a scratch instance, documented in `docs/RUNBOOK.md` (Claude Code writes this in the last milestone).

Environment variables are listed in `docs/API.md` §Configuration.

## 17. Testing and definition of done

A milestone is done when all of these hold:

1. `pnpm typecheck && pnpm lint && pnpm test` passes.
2. The milestone's acceptance checks in `MILESTONES.md` pass as automated tests.
3. The route authorization test (§4) covers every route.
4. `pnpm e2e` passes: Playwright runs the main journey with fakes (sign in → import CSV → research → draft and send email → simulated reply → book meeting → proposal → contract signed → deal Won → appears in forecast).
5. No TODO, mock data or simulated AI remains in `apps/`.
6. Screens were checked in a real browser at 1280 px and 390 px, with screenshots attached to the pull request.

Unit test coverage is required for `packages/shared` (pricing, stages, fit, next best actions, slots) at 95% lines or better. Time-dependent logic takes the current time as a parameter and is tested on a Friday afternoon, a weekend, across a daylight-saving change and in two time zones.
