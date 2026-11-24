CREATE TYPE "public"."account_source" AS ENUM('manual', 'csv', 'provider');--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('note', 'email_out', 'email_in', 'call', 'voicemail', 'linkedin', 'meeting', 'stage_change', 'proposal_sent', 'proposal_viewed', 'contract_sent', 'contract_signed', 'task_done', 'owner_change');--> statement-breakpoint
CREATE TYPE "public"."contact_email_status" AS ENUM('ok', 'unsubscribed', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'sent', 'viewed', 'signed', 'declined', 'voided');--> statement-breakpoint
CREATE TYPE "public"."deal_stage" AS ENUM('lead', 'researched', 'contacted', 'meeting_set', 'proposal', 'contract_sent', 'won');--> statement-breakpoint
CREATE TYPE "public"."deal_status" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('draft', 'sent', 'logged', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."email_direction" AS ENUM('out', 'in');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('queued', 'sent', 'failed', 'bounced', 'received');--> statement-breakpoint
CREATE TYPE "public"."mail_provider" AS ENUM('microsoft', 'google');--> statement-breakpoint
CREATE TYPE "public"."meeting_kind" AS ENUM('site_walk', 'call', 'video', 'internal');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'done', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."outreach_channel" AS ENUM('email', 'call', 'voicemail', 'linkedin');--> statement-breakpoint
CREATE TYPE "public"."phone_type" AS ENUM('business', 'mobile', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'sent', 'viewed', 'accepted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('website', 'search', 'upload', 'rep_note', 'provider');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribe', 'bounce', 'complaint', 'manual');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ae', 'manager', 'admin');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"property_type" text NOT NULL,
	"address_line" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"lat" double precision,
	"lng" double precision,
	"owner_company" text,
	"size_text" text,
	"year_built" integer,
	"occupancy_pct" integer,
	"current_provider" text,
	"contract_timing" text,
	"contract_end_date" date,
	"website" text,
	"is_existing_client" boolean DEFAULT false NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"fit_score" integer,
	"fit_reasons" jsonb DEFAULT '[]' NOT NULL,
	"source" "account_source" DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"owner_user_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "accounts_occupancy_pct_check" CHECK (occupancy_pct BETWEEN 0 AND 100),
	CONSTRAINT "accounts_fit_score_check" CHECK (fit_score BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"deal_id" uuid,
	"contact_id" uuid,
	"user_id" uuid,
	"type" "activity_type" NOT NULL,
	"subject" text,
	"body" text,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"ok" boolean NOT NULL,
	"error" text,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label_named" text NOT NULL,
	"label_anonymized" text NOT NULL,
	"property_types" text[] NOT NULL,
	"stats" jsonb NOT NULL,
	"named_permission" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"title" text,
	"email" "citext",
	"phone" text,
	"phone_type" "phone_type" DEFAULT 'unknown' NOT NULL,
	"linkedin_url" text,
	"contact_pref" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"email_status" "contact_email_status" DEFAULT 'ok' NOT NULL,
	"do_not_call" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"esign_provider" text NOT NULL,
	"provider_envelope_id" text,
	"signer_contact_id" uuid,
	"view_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signed_pdf_object_key" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_provider_envelope_id_key" UNIQUE("provider_envelope_id")
);
--> statement-breakpoint
CREATE TABLE "deal_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"from_stage" "deal_stage",
	"to_stage" "deal_stage" NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stage" "deal_stage" DEFAULT 'lead' NOT NULL,
	"status" "deal_status" DEFAULT 'open' NOT NULL,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"package" jsonb,
	"annual_value_cents" bigint DEFAULT 0 NOT NULL,
	"expected_close" date,
	"lost_reason" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_annual_value_cents_check" CHECK (annual_value_cents >= 0),
	CONSTRAINT "deals_check" CHECK ((status = 'won') = (stage = 'won')),
	CONSTRAINT "deals_check1" CHECK (status <> 'lost' OR lost_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"deal_id" uuid,
	"contact_id" uuid,
	"direction" "email_direction" NOT NULL,
	"status" "email_status" NOT NULL,
	"provider" "mail_provider" NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text,
	"from_email" "citext" NOT NULL,
	"to_email" "citext" NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"error" text,
	"ai_classification" text,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_draft_id_key" UNIQUE("draft_id"),
	CONSTRAINT "email_messages_provider_provider_message_id_key" UNIQUE("provider","provider_message_id"),
	CONSTRAINT "email_messages_ai_classification_check" CHECK (ai_classification IN ('interested', 'not_now', 'not_interested', 'out_of_office', 'unsubscribe', 'other'))
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"column_map" jsonb,
	"rows_total" integer,
	"rows_created" integer,
	"rows_skipped" integer,
	"errors" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_status_check" CHECK (status IN ('uploaded', 'previewed', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"deal_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"contact_ids" uuid[] DEFAULT '{}' NOT NULL,
	"title" text NOT NULL,
	"kind" "meeting_kind" DEFAULT 'site_walk' NOT NULL,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"location_text" text,
	"lat" double precision,
	"lng" double precision,
	"provider" "mail_provider",
	"provider_event_id" text,
	"prep_brief" jsonb,
	"prep_ai_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_check" CHECK (ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"user_id" uuid NOT NULL,
	"provider" "mail_provider" NOT NULL,
	"subject" text NOT NULL,
	"scopes" text[] NOT NULL,
	"access_token_enc" "bytea" NOT NULL,
	"refresh_token_enc" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mail_sync_cursor" text,
	"needs_reconnect" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY("user_id","provider"),
	CONSTRAINT "oauth_accounts_provider_subject_key" UNIQUE("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "outreach_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"deal_id" uuid,
	"contact_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "outreach_channel" NOT NULL,
	"tone" text DEFAULT 'professional' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"checks" jsonb DEFAULT '[]' NOT NULL,
	"ai_call_id" uuid,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_drafts_tone_check" CHECK (tone IN ('professional', 'friendly', 'direct'))
);
--> statement-breakpoint
CREATE TABLE "pricing_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effective_from" date NOT NULL,
	"hourly_rate_cents" jsonb NOT NULL,
	"coverage_hours_per_week" jsonb NOT NULL,
	"supervisor_multiplier" numeric(5, 4) DEFAULT 1.05 NOT NULL,
	"addons" jsonb NOT NULL,
	"term_discounts" jsonb NOT NULL,
	"max_manual_discount" numeric(5, 4) DEFAULT 0.10 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_configs_effective_from_key" UNIQUE("effective_from")
);
--> statement-breakpoint
CREATE TABLE "proposal_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"package" jsonb NOT NULL,
	"pricing" jsonb NOT NULL,
	"manual_discount" numeric(5, 4) DEFAULT 0 NOT NULL,
	"discount_approved_by" uuid,
	"cover_note" text,
	"pdf_object_key" text,
	"public_token_hash" text,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_public_token_hash_key" UNIQUE("public_token_hash"),
	CONSTRAINT "proposals_deal_id_version_key" UNIQUE("deal_id","version"),
	CONSTRAINT "proposals_manual_discount_check" CHECK (manual_discount >= 0 AND manual_discount < 1)
);
--> statement-breakpoint
CREATE TABLE "research_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sections" jsonb NOT NULL,
	"recommended_package" jsonb NOT NULL,
	"ai_call_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_briefs_account_id_version_key" UNIQUE("account_id","version")
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"url" text,
	"title" text,
	"content_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" uuid,
	CONSTRAINT "research_sources_account_id_content_hash_key" UNIQUE("account_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"text" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"source_id" uuid,
	"observed_on" date,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_kind_check" CHECK (kind IN ('incident', 'timing', 'tenant', 'growth', 'other'))
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"email" "citext" PRIMARY KEY NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid,
	"deal_id" uuid,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT 'Account Executive' NOT NULL,
	"phone" text,
	"role" "user_role" DEFAULT 'ae' NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"base_address" text,
	"base_lat" double precision,
	"base_lng" double precision,
	"workday_start" time DEFAULT '08:00' NOT NULL,
	"workday_end" time DEFAULT '17:30' NOT NULL,
	"daily_send_cap" integer DEFAULT 50 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_daily_send_cap_check" CHECK (daily_send_cap BETWEEN 0 AND 500)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_signer_contact_id_fkey" FOREIGN KEY ("signer_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_prep_ai_call_id_fkey" FOREIGN KEY ("prep_ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_ai_call_id_fkey" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_configs" ADD CONSTRAINT "pricing_configs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_views" ADD CONSTRAINT "proposal_views_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_discount_approved_by_fkey" FOREIGN KEY ("discount_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_briefs" ADD CONSTRAINT "research_briefs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_briefs" ADD CONSTRAINT "research_briefs_ai_call_id_fkey" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_briefs" ADD CONSTRAINT "research_briefs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."research_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_owner_idx" ON "accounts" USING btree ("owner_user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "accounts_name_trgm" ON "accounts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_city_type_idx" ON "accounts" USING btree ("city","property_type") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_dedupe" ON "accounts" USING btree (lower(name),lower(coalesce(city, ''))) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "activities_account_time_idx" ON "activities" USING btree ("account_id","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "activities_deal_time_idx" ON "activities" USING btree ("deal_id","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ai_calls_user_time_idx" ON "ai_calls" USING btree ("user_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_time_idx" ON "audit_log" USING btree ("created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "contacts_account_idx" ON "contacts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_one_primary" ON "contacts" USING btree ("account_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "contracts_deal_idx" ON "contracts" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "deal_stage_history_deal_idx" ON "deal_stage_history" USING btree ("deal_id","changed_at");--> statement-breakpoint
CREATE INDEX "deals_owner_status_idx" ON "deals" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "deals_account_idx" ON "deals" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_one_open_per_account" ON "deals" USING btree ("account_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "email_messages_thread_idx" ON "email_messages" USING btree ("provider","provider_thread_id");--> statement-breakpoint
CREATE INDEX "email_messages_user_sent_idx" ON "email_messages" USING btree ("user_id","sent_at") WHERE direction = 'out';--> statement-breakpoint
CREATE INDEX "meetings_owner_time_idx" ON "meetings" USING btree ("owner_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "outreach_drafts_user_idx" ON "outreach_drafts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "proposal_views_proposal_idx" ON "proposal_views" USING btree ("proposal_id","viewed_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "signals_account_idx" ON "signals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "tasks_owner_open_idx" ON "tasks" USING btree ("owner_user_id","due_at") WHERE done_at IS NULL;