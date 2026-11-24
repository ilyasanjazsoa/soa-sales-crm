# API and configuration

All routes are under `/api`, need a session unless marked public, and apply the visibility rule in `ARCHITECTURE.md` §4. Request and response shapes are Zod schemas in `packages/shared/api.ts`. "M" = manager or admin only. "A" = admin only.

## Auth and profile

| Method and path | Purpose |
|---|---|
| `GET /auth/login` | Starts the single sign-on redirect (public) |
| `GET /auth/callback` | Completes sign-in, stores tokens, sets the session cookie (public) |
| `POST /auth/logout` | Ends the session |
| `GET /me` | Current user, role, mail connection status, CSRF token |
| `PATCH /me` | Time zone, base address (geocoded), working hours, phone, title |

## Accounts, contacts, signals

| Method and path | Purpose |
|---|---|
| `GET /accounts?q=&city=&type=&minFit=&owner=me\|unassigned\|all&cursor=` | Prospect finder search |
| `POST /accounts` | Create (409 with the existing id on a duplicate name + city) |
| `GET /accounts/:id` | Account with contacts, open deal, latest brief id, counts |
| `PATCH /accounts/:id` | Edit fields |
| `POST /accounts/:id/claim` | Take an unassigned account (409 if already owned) |
| `POST /accounts/:id/assign` | Set owner (M) |
| `DELETE /accounts/:id` | Soft delete; `?purge=true` hard delete (M) |
| `POST /accounts/:id/contacts`, `PATCH /contacts/:id`, `DELETE /contacts/:id` | Contacts |
| `POST /contacts/:id/erase` | Remove personal fields, keep suppression (M) |
| `GET /accounts/:id/signals`, `POST /accounts/:id/signals`, `PATCH /signals/:id`, `DELETE /signals/:id` | Signals, including confirm |
| `GET /accounts/:id/timeline?cursor=` | Activities, newest first |
| `POST /accounts/:id/notes` | Add a note |

## Imports and export

| Method and path | Purpose |
|---|---|
| `POST /imports` (multipart CSV) | Upload; returns detected columns and the first 20 rows |
| `POST /imports/:id/preview` | Send the column map; returns counts of new, duplicate and invalid rows |
| `POST /imports/:id/run` | Start the import job |
| `GET /imports/:id` | Status and row errors |
| `GET /export/accounts.csv`, `GET /export/deals.csv` | Export (M, audited) |

CSV columns recognised: account name (required), property type, address, city, state, postal code, owner company, size, year built, occupancy, current provider, contract end date, website, contact first name, contact last name, contact title, contact email, contact phone, signal. Imported accounts are unassigned unless the importer ticks "assign to me".

## Research

| Method and path | Purpose |
|---|---|
| `GET /accounts/:id/sources` | Stored sources |
| `POST /accounts/:id/sources` | Add a rep note or pasted text as a source |
| `POST /accounts/:id/research/fetch` | Fetch the account's website into sources and extract signals (job) |
| `POST /accounts/:id/brief` | Generate a new brief version (job); 422 if there are no sources and no signals |
| `GET /accounts/:id/brief` | Latest brief with sources resolved; `?version=` for older ones |

## Deals and tasks

| Method and path | Purpose |
|---|---|
| `GET /deals?stage=&status=&owner=&cursor=` | Pipeline data |
| `POST /accounts/:id/deals` | Create the open deal (409 if one exists) |
| `PATCH /deals/:id` | Name, package, expected close |
| `POST /deals/:id/stage` | Manual stage move (rules in `ARCHITECTURE.md` §5) |
| `POST /deals/:id/lose` | Mark lost with a reason |
| `POST /deals/:id/reopen` | Reopen a lost deal (M) |
| `GET /forecast?owner=` | Totals and weighted forecast by stage |
| `GET /tasks?open=true`, `POST /tasks`, `PATCH /tasks/:id` | Tasks |

## Outreach

| Method and path | Purpose |
|---|---|
| `POST /accounts/:id/drafts` | Body: `{ contactId, channel, tone, useAi }`. Creates a draft; with `useAi` calls `outreach_draft` |
| `GET /drafts/:id`, `PATCH /drafts/:id` | Read and edit; every save re-runs checks and returns them |
| `POST /drafts/:id/regenerate` | New AI draft into the same row |
| `POST /drafts/:id/send` | Email only. The single send path (`ARCHITECTURE.md` §8.2) |
| `POST /drafts/:id/log` | Call, voicemail, LinkedIn: record the outcome, set `logged` |
| `DELETE /drafts/:id` | Discard |
| `GET /accounts/:id/emails` | Sent and received messages on CRM threads |
| `POST /emails/:id/retry` | Re-queue a failed message |
| `GET /suppressions`, `POST /suppressions` (M), `DELETE /suppressions/:email` (M, audited) | Suppression list |

## Meetings

| Method and path | Purpose |
|---|---|
| `POST /accounts/:id/slots` | Body: `{ durationMinutes, kind }`. Returns up to 3 slots with reasons |
| `POST /meetings` | Book a slot (409 if no longer free) |
| `GET /meetings?from=&to=&owner=` | Calendar data: CRM meetings plus busy blocks (titles of non-CRM events are shown only to their owner) |
| `PATCH /meetings/:id` | Reschedule, cancel, set outcome |
| `GET /meetings/:id/prep`, `POST /meetings/:id/prep` | Read or regenerate the prep brief |

## Pricing, proposals, contracts

| Method and path | Purpose |
|---|---|
| `POST /pricing/quote` | Body: `Package` + optional `manualDiscount`. Returns `PriceBreakdown` |
| `GET /pricing/config`, `POST /pricing/config` (M) | Live pricing; create a new version |
| `POST /deals/:id/proposals` | New proposal version from a package |
| `PATCH /proposals/:id` | Edit a draft proposal |
| `POST /proposals/:id/approve-discount` (M) | Approve a discount above the limit |
| `POST /proposals/:id/render` | Generate the PDF (job) |
| `POST /proposals/:id/send` | Create the share link and an email draft containing it |
| `GET /proposals/:id` | Proposal with view count and last viewed time |
| `POST /proposals/:id/contract` | Body: `{ signerContactId, startDate }`. Create and send the envelope |
| `GET /contracts/:id` | Status; signed PDF download link when signed |
| `POST /contracts/:id/void` | Void an unsigned contract |

## Today, Ask, admin

| Method and path | Purpose |
|---|---|
| `GET /today` | Stats, next best actions, today's schedule |
| `POST /ask` | Body: `{ question }`. Returns `{ answer, items }` |
| `GET /admin/users`, `POST /admin/users`, `PATCH /admin/users/:id` (A) | Users and roles; deactivating a user requires reassigning their accounts |
| `GET /admin/references`, `POST`, `PATCH /admin/references/:id` (M) | Client references |
| `GET /admin/audit?entity=&user=&cursor=` (A) | Audit log |

## Public routes (no session)

| Method and path | Purpose |
|---|---|
| `GET /p/:token` | Proposal viewer |
| `GET /u/:token`, `POST /u/:token` | Unsubscribe |
| `POST /webhooks/esign` | E-signature events |
| `GET /healthz`, `GET /readyz` | Health |

## Configuration

Startup validates these with Zod and exits with a clear message if one is missing.

| Variable | Meaning |
|---|---|
| `NODE_ENV`, `PORT`, `PUBLIC_URL`, `APP_URL` | Basics. `PUBLIC_URL` is the internet-facing host for `/p`, `/u`, `/webhooks` |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET`, `TOKEN_ENC_KEY`, `UNSUBSCRIBE_SECRET`, `IP_HASH_SALT` | 32-byte secrets |
| `IDP` | `microsoft` or `google` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_TENANT_ID` (Microsoft) | Sign-in and mail/calendar app registration |
| `ALLOWED_EMAIL_DOMAIN`, `BOOTSTRAP_ADMIN_EMAIL` | Who may sign in; the first admin |
| `AWS_REGION`, `AI_MODEL_WRITER`, `AI_MODEL_FAST` | Bedrock region and model ids |
| `S3_BUCKET`, `S3_ENDPOINT` (local only) | File storage |
| `MAPS_PROVIDER`, `MAPS_API_KEY` | Geocoding and drive time |
| `ESIGN_PROVIDER`, `ESIGN_API_KEY`, `ESIGN_WEBHOOK_SECRET`, `ESIGN_TEMPLATE_ID` | E-signature |
| `COMPANY_NAME`, `COMPANY_POSTAL_ADDRESS`, `COMPANY_SIGNER_NAME`, `COMPANY_SIGNER_EMAIL` | Email footer and contract counter-signer |
| `MAIL_ALLOWLIST` | Staging only: comma-separated addresses that mail may be sent to; all others are blocked |
| `FAKE_PROVIDERS` | Local and CI: `true` swaps every external provider for its fake |
