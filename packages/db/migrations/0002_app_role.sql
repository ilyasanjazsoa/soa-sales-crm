-- The application runs as role crm_app (the api and worker `SET ROLE crm_app` on every connection).
-- audit_log is append-only for the application: INSERT and SELECT only (ARCHITECTURE.md §5).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT crm_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM crm_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
