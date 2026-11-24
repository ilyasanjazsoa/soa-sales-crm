import { describe, expect, it } from "vitest";
import { EnvError, parseEnv, REAL_PROVIDER_VARIABLES, type EnvSource } from "./env";

const SECRET = "a".repeat(64);

const valid = (overrides: Record<string, string | undefined> = {}): EnvSource => ({
  NODE_ENV: "development",
  PORT: "3000",
  PUBLIC_URL: "http://localhost:3000",
  APP_URL: "http://localhost:5173",
  DATABASE_URL: "postgres://crm:crm@localhost:5432/crm",
  SESSION_SECRET: SECRET,
  TOKEN_ENC_KEY: SECRET,
  UNSUBSCRIBE_SECRET: SECRET,
  IP_HASH_SALT: SECRET,
  IDP: "microsoft",
  ALLOWED_EMAIL_DOMAIN: "soa.example",
  BOOTSTRAP_ADMIN_EMAIL: "admin@soa.example",
  AWS_REGION: "us-east-1",
  AI_MODEL_WRITER: "fake-writer",
  AI_MODEL_FAST: "fake-fast",
  S3_BUCKET: "soa-crm-test",
  COMPANY_NAME: "Security Of America",
  FAKE_PROVIDERS: "true",
  ...overrides,
});

const errorOf = (source: EnvSource): EnvError => {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error("expected parseEnv to throw");
};

describe("parseEnv", () => {
  it("accepts a complete local configuration and converts types", () => {
    const env = parseEnv(valid({ MAIL_ALLOWLIST: " A@soa.example, b@soa.example ,," }));
    expect(env.PORT).toBe(3000);
    expect(env.FAKE_PROVIDERS).toBe(true);
    expect(env.MAIL_ALLOWLIST).toEqual(["a@soa.example", "b@soa.example"]);
    expect(env.COMPANY_POSTAL_ADDRESS).toBeUndefined();
  });

  it("names every missing variable, treating blank values as missing", () => {
    const error = errorOf(valid({ DATABASE_URL: undefined, SESSION_SECRET: "  " }));
    expect(error.missing).toEqual(["DATABASE_URL", "SESSION_SECRET"]);
    expect(error.message).toContain("Missing required variable(s): DATABASE_URL, SESSION_SECRET");
  });

  it("explains invalid values without echoing them", () => {
    const error = errorOf(valid({ TOKEN_ENC_KEY: "short-secret-value", PORT: "http" }));
    expect([...error.invalid.keys()].sort()).toEqual(["PORT", "TOKEN_ENC_KEY"]);
    expect(error.message).toContain("TOKEN_ENC_KEY must be 32 bytes");
    expect(error.message).not.toContain("short-secret-value");
  });

  it("requires real provider settings only when fakes are off", () => {
    const error = errorOf(valid({ FAKE_PROVIDERS: "false" }));
    expect(error.missing).toEqual([...REAL_PROVIDER_VARIABLES, "OIDC_TENANT_ID"].sort());
  });

  it("does not need a tenant id for Google sign-in", () => {
    const error = errorOf(valid({ FAKE_PROVIDERS: "false", IDP: "google" }));
    expect(error.missing).not.toContain("OIDC_TENANT_ID");
  });

  it("refuses fake providers in production", () => {
    const error = errorOf(valid({ NODE_ENV: "production" }));
    expect(error.invalid.get("FAKE_PROVIDERS")).toBe("must be false in production");
  });

  it("requires the bootstrap admin to be in the allowed domain", () => {
    const error = errorOf(valid({ BOOTSTRAP_ADMIN_EMAIL: "admin@other.example" }));
    expect(error.invalid.get("BOOTSTRAP_ADMIN_EMAIL")).toBe("must be in ALLOWED_EMAIL_DOMAIN");
  });

  it("rejects a bad allow-list entry", () => {
    const error = errorOf(valid({ MAIL_ALLOWLIST: "ok@soa.example,not-an-email" }));
    expect(error.invalid.has("MAIL_ALLOWLIST")).toBe(true);
  });
});
