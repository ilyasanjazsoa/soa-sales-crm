-- Security Of America Sales CRM: database schema (PostgreSQL 16)
-- Source of truth for milestone 1. Implement as Drizzle schema + generated migrations that produce exactly this.
-- Conventions: uuid primary keys, timestamptz everywhere, money in integer cents, soft delete only where noted.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search on names

-- ───────── enums ─────────
CREATE TYPE user_role        AS ENUM ('ae', 'manager', 'admin');
CREATE TYPE mail_provider    AS ENUM ('microsoft', 'google');
CREATE TYPE deal_stage       AS ENUM ('lead', 'researched', 'contacted', 'meeting_set', 'proposal', 'contract_sent', 'won');
CREATE TYPE deal_status      AS ENUM ('open', 'won', 'lost');
CREATE TYPE outreach_channel AS ENUM ('email', 'call', 'voicemail', 'linkedin');
CREATE TYPE draft_status     AS ENUM ('draft', 'sent', 'logged', 'discarded');
CREATE TYPE email_direction  AS ENUM ('out', 'in');
CREATE TYPE email_status     AS ENUM ('queued', 'sent', 'failed', 'bounced', 'received');
CREATE TYPE contact_email_status AS ENUM ('ok', 'unsubscribed', 'bounced');
CREATE TYPE phone_type       AS ENUM ('business', 'mobile', 'unknown');
CREATE TYPE suppression_reason AS ENUM ('unsubscribe', 'bounce', 'complaint', 'manual');
CREATE TYPE meeting_kind     AS ENUM ('site_walk', 'call', 'video', 'internal');
CREATE TYPE meeting_status   AS ENUM ('scheduled', 'done', 'cancelled', 'no_show');
CREATE TYPE proposal_status  AS ENUM ('draft', 'sent', 'viewed', 'accepted', 'expired');
CREATE TYPE contract_status  AS ENUM ('draft', 'sent', 'viewed', 'signed', 'declined', 'voided');
CREATE TYPE source_kind      AS ENUM ('website', 'search', 'upload', 'rep_note', 'provider');
CREATE TYPE account_source   AS ENUM ('manual', 'csv', 'provider');
CREATE TYPE activity_type    AS ENUM ('note', 'email_out', 'email_in', 'call', 'voicemail', 'linkedin', 'meeting',
                                      'stage_change', 'proposal_sent', 'proposal_viewed', 'contract_sent',
                                      'contract_signed', 'task_done', 'owner_change');

-- ───────── people and sessions ─────────
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE,
  name             text NOT NULL,
  title            text NOT NULL DEFAULT 'Account Executive',
  phone            text,
  role             user_role NOT NULL DEFAULT 'ae',
  timezone         text NOT NULL DEFAULT 'America/Chicago',      -- IANA name
  base_address     text,                                         -- where the rep's day starts (office or home)
  base_lat         double precision,
  base_lng         double precision,
  workday_start    time NOT NULL DEFAULT '08:00',
  workday_end      time NOT NULL DEFAULT '17:30',
  daily_send_cap   integer NOT NULL DEFAULT 50 CHECK (daily_send_cap BETWEEN 0 AND 500),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per user per provider. Tokens are encrypted by the app (AES-256-GCM, key from the secrets manager).
CREATE TABLE oauth_accounts (
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           mail_provider NOT NULL,
  subject            text NOT NULL,                 -- the provider's stable user id
  scopes             text[] NOT NULL,
  access_token_enc   bytea NOT NULL,
  refresh_token_enc  bytea NOT NULL,
  expires_at         timestamptz NOT NULL,
  mail_sync_cursor   text,                          -- Graph delta link or Gmail historyId
  needs_reconnect    boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,                    -- sha256 of the cookie value; the raw value is never stored
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           inet,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ───────── accounts (a prospect property or company) ─────────
CREATE TABLE accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  property_type      text NOT NULL,                 -- from the property_types list in pricing/config, e.g. 'Industrial'
  address_line       text,
  city               text,
  state              text,
  postal_code        text,
  lat                double precision,
  lng                double precision,
  owner_company      text,                          -- who owns or manages the property
  size_text          text,                          -- e.g. '640,000 sq ft, 4 buildings'
  year_built         integer,
  occupancy_pct      integer CHECK (occupancy_pct BETWEEN 0 AND 100),
  current_provider   text,                          -- incumbent security, 'None', 'In-house'
  contract_timing    text,                          -- free text, e.g. 'Contract ends Jan 31'
  contract_end_date  date,
  website            text,
  is_existing_client boolean NOT NULL DEFAULT false,
  do_not_contact     boolean NOT NULL DEFAULT false,
  fit_score          integer CHECK (fit_score BETWEEN 0 AND 100),
  fit_reasons        jsonb NOT NULL DEFAULT '[]',   -- string[]
  source             account_source NOT NULL DEFAULT 'manual',
  source_ref         text,                          -- import id or provider record id
  owner_user_id      uuid REFERENCES users(id),     -- NULL = unassigned pool, visible to everyone, claimable
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX accounts_owner_idx ON accounts (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX accounts_name_trgm ON accounts USING gin (name gin_trgm_ops);
CREATE INDEX accounts_city_type_idx ON accounts (city, property_type) WHERE deleted_at IS NULL;
-- Duplicate guard used by manual create and CSV import.
CREATE UNIQUE INDEX accounts_dedupe ON accounts (lower(name), lower(coalesce(city, ''))) WHERE deleted_at IS NULL;

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  first_name    text NOT NULL,
  last_name     text NOT NULL DEFAULT '',
  title         text,
  email         citext,
  phone         text,
  phone_type    phone_type NOT NULL DEFAULT 'unknown',
  linkedin_url  text,
  contact_pref  text,                               -- e.g. 'Best reached by phone after 2 pm'
  is_primary    boolean NOT NULL DEFAULT false,
  email_status  contact_email_status NOT NULL DEFAULT 'ok',
  do_not_call   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_account_idx ON contacts (account_id);
CREATE INDEX contacts_email_idx ON contacts (email);
CREATE UNIQUE INDEX contacts_one_primary ON contacts (account_id) WHERE is_primary;

-- ───────── research ─────────
-- Every fact the AI may use must come from a row here. content_text is untrusted input.
CREATE TABLE research_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          source_kind NOT NULL,
  url           text,
  title         text,
  content_text  text NOT NULL,
  content_hash  text NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  added_by      uuid REFERENCES users(id),
  UNIQUE (account_id, content_hash)
);

CREATE TABLE signals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  text         text NOT NULL,                       -- e.g. '2 cargo thefts in the park in the last 90 days'
  kind         text NOT NULL DEFAULT 'other' CHECK (kind IN ('incident', 'timing', 'tenant', 'growth', 'other')),
  source_id    uuid REFERENCES research_sources(id) ON DELETE SET NULL,
  observed_on  date,
  confirmed    boolean NOT NULL DEFAULT false,      -- a rep has confirmed an AI-extracted signal
  created_by   uuid REFERENCES users(id),           -- NULL = extracted by AI
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signals_account_idx ON signals (account_id);

CREATE TABLE ai_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users(id),
  feature        text NOT NULL,                     -- 'research_brief' | 'outreach_draft' | 'prep_brief' | 'ask' | 'signal_extract' | 'reply_classify' | 'claim_check'
  model          text NOT NULL,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  ok             boolean NOT NULL,
  error          text,
  request        jsonb NOT NULL,                    -- purged after 90 days by a nightly job
  response       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_user_time_idx ON ai_calls (user_id, created_at DESC);

CREATE TABLE research_briefs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version              integer NOT NULL,
  sections             jsonb NOT NULL,              -- [{ key, heading, text, sourceIds: uuid[] }]
  recommended_package  jsonb NOT NULL,              -- Package (see ARCHITECTURE.md §6)
  ai_call_id           uuid REFERENCES ai_calls(id),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, version)
);

-- Proof points for outreach. Standalone CRM: sales managers maintain these by hand.
-- Later they can be fed from the operations system. named_permission = false means outreach may only use label_anonymized.
CREATE TABLE client_references (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label_named       text NOT NULL,                  -- e.g. the real client/site name. Never leaves the building unless named_permission.
  label_anonymized  text NOT NULL,                  -- e.g. 'a logistics hub we protect in Irving'
  property_types    text[] NOT NULL,
  stats             jsonb NOT NULL,                 -- { patrolCompliancePct: 98.4, avgResponseMin: 4, ... }
  named_permission  boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ───────── deals ─────────
CREATE TABLE deals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id      uuid NOT NULL REFERENCES users(id),
  name               text NOT NULL,
  stage              deal_stage NOT NULL DEFAULT 'lead',
  status             deal_status NOT NULL DEFAULT 'open',
  stage_changed_at   timestamptz NOT NULL DEFAULT now(),
  package            jsonb,                         -- Package
  annual_value_cents bigint NOT NULL DEFAULT 0 CHECK (annual_value_cents >= 0),
  expected_close     date,
  lost_reason        text,
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'won') = (stage = 'won')),
  CHECK (status <> 'lost' OR lost_reason IS NOT NULL)
);
CREATE INDEX deals_owner_status_idx ON deals (owner_user_id, status);
CREATE INDEX deals_account_idx ON deals (account_id);
CREATE UNIQUE INDEX deals_one_open_per_account ON deals (account_id) WHERE status = 'open';

CREATE TABLE deal_stage_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage  deal_stage,
  to_stage    deal_stage NOT NULL,
  changed_by  uuid REFERENCES users(id),            -- NULL = system (e.g. signature webhook)
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deal_stage_history_deal_idx ON deal_stage_history (deal_id, changed_at);

CREATE TABLE activities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id      uuid REFERENCES users(id),           -- NULL = system
  type         activity_type NOT NULL,
  subject      text,
  body         text,
  meta         jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_account_time_idx ON activities (account_id, occurred_at DESC);
CREATE INDEX activities_deal_time_idx ON activities (deal_id, occurred_at DESC);

CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals(id) ON DELETE CASCADE,
  title       text NOT NULL,
  due_at      timestamptz,
  done_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_owner_open_idx ON tasks (owner_user_id, due_at) WHERE done_at IS NULL;

-- ───────── outreach ─────────
CREATE TABLE outreach_drafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals(id) ON DELETE SET NULL,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  channel     outreach_channel NOT NULL,
  tone        text NOT NULL DEFAULT 'professional' CHECK (tone IN ('professional', 'friendly', 'direct')),
  subject     text,
  body        text NOT NULL,
  checks      jsonb NOT NULL DEFAULT '[]',          -- [{ id, pass, blocking, label }] from the last check run
  ai_call_id  uuid REFERENCES ai_calls(id),
  status      draft_status NOT NULL DEFAULT 'draft',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outreach_drafts_user_idx ON outreach_drafts (user_id, status);

CREATE TABLE email_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            uuid UNIQUE REFERENCES outreach_drafts(id) ON DELETE SET NULL,  -- UNIQUE = a draft can be sent once
  user_id             uuid NOT NULL REFERENCES users(id),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id             uuid REFERENCES deals(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  direction           email_direction NOT NULL,
  status              email_status NOT NULL,
  provider            mail_provider NOT NULL,
  provider_message_id text,
  provider_thread_id  text,
  from_email          citext NOT NULL,
  to_email            citext NOT NULL,
  subject             text NOT NULL,
  body_text           text NOT NULL,
  error               text,
  ai_classification   text CHECK (ai_classification IN ('interested', 'not_now', 'not_interested', 'out_of_office', 'unsubscribe', 'other')),
  sent_at             timestamptz,
  received_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX email_messages_thread_idx ON email_messages (provider, provider_thread_id);
CREATE INDEX email_messages_user_sent_idx ON email_messages (user_id, sent_at) WHERE direction = 'out';

-- Checked on every send. Company-wide: one rep's unsubscribe applies to all reps.
CREATE TABLE suppressions (
  email       citext PRIMARY KEY,
  reason      suppression_reason NOT NULL,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────── meetings ─────────
CREATE TABLE meetings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id            uuid REFERENCES deals(id) ON DELETE SET NULL,
  owner_user_id      uuid NOT NULL REFERENCES users(id),
  contact_ids        uuid[] NOT NULL DEFAULT '{}',
  title              text NOT NULL,
  kind               meeting_kind NOT NULL DEFAULT 'site_walk',
  status             meeting_status NOT NULL DEFAULT 'scheduled',
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  location_text      text,
  lat                double precision,
  lng                double precision,
  provider           mail_provider,
  provider_event_id  text,
  prep_brief         jsonb,                         -- [{ key, heading, text }]
  prep_ai_call_id    uuid REFERENCES ai_calls(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX meetings_owner_time_idx ON meetings (owner_user_id, starts_at);

-- ───────── pricing, proposals, contracts ─────────
-- Versioned. The row with the latest effective_from <= today is live. Proposals snapshot the numbers they used.
CREATE TABLE pricing_configs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from         date NOT NULL UNIQUE,
  hourly_rate_cents      jsonb NOT NULL,            -- { "unarmed": 2900, "armed": 3800 }
  coverage_hours_per_week jsonb NOT NULL,           -- { "24_7": 168, "nights": 84, "business_hours": 60 }
  supervisor_multiplier  numeric(5,4) NOT NULL DEFAULT 1.05,
  addons                 jsonb NOT NULL,            -- { "patrol": { "label": "...", "monthlyCents": 145000 }, ... }
  term_discounts         jsonb NOT NULL,            -- { "12": 0, "24": 0.03, "36": 0.05 }
  max_manual_discount    numeric(5,4) NOT NULL DEFAULT 0.10,  -- above this needs a manager
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id            uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  version            integer NOT NULL,
  status             proposal_status NOT NULL DEFAULT 'draft',
  package            jsonb NOT NULL,                -- Package
  pricing            jsonb NOT NULL,                -- PriceBreakdown snapshot, including pricing_config_id
  manual_discount    numeric(5,4) NOT NULL DEFAULT 0 CHECK (manual_discount >= 0 AND manual_discount < 1),
  discount_approved_by uuid REFERENCES users(id),
  cover_note         text,
  pdf_object_key     text,
  public_token_hash  text UNIQUE,                   -- sha256 of the token in the share link
  sent_at            timestamptz,
  expires_at         timestamptz,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, version)
);

CREATE TABLE proposal_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  viewed_at    timestamptz NOT NULL DEFAULT now(),
  ip_hash      text,
  user_agent   text
);
CREATE INDEX proposal_views_proposal_idx ON proposal_views (proposal_id, viewed_at);

CREATE TABLE contracts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  proposal_id           uuid NOT NULL REFERENCES proposals(id),
  status                contract_status NOT NULL DEFAULT 'draft',
  esign_provider        text NOT NULL,
  provider_envelope_id  text UNIQUE,
  signer_contact_id     uuid REFERENCES contacts(id) ON DELETE SET NULL,
  view_count            integer NOT NULL DEFAULT 0,
  sent_at               timestamptz,
  signed_at             timestamptz,
  signed_pdf_object_key text,
  created_by            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contracts_deal_idx ON contracts (deal_id);

-- ───────── imports and audit ─────────
CREATE TABLE imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  filename      text NOT NULL,
  object_key    text NOT NULL,
  status        text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'previewed', 'running', 'done', 'failed')),
  column_map    jsonb,
  rows_total    integer,
  rows_created  integer,
  rows_skipped  integer,
  errors        jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Append-only. The application database user has INSERT and SELECT only on this table.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  user_id      uuid REFERENCES users(id),
  action       text NOT NULL,                       -- e.g. 'email.send', 'deal.stage', 'account.export', 'auth.login'
  entity_type  text,
  entity_id    uuid,
  meta         jsonb NOT NULL DEFAULT '{}',
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_time_idx ON audit_log (created_at DESC);
