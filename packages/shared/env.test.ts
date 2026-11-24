import { describe, expect, it } from "vitest";
import { EnvError, parseEnv, REAL_PROVIDER_VARIABLES, type EnvSource } from "./env";

const secret = (c: string) => c.repeat(64);

const valid = (overrides: Record<string, string | undefined> = {}): EnvSource => ({
  NODE_ENV: "development",
  PORT: "3000",
  PUBLIC_URL: "http://localhost:3000",
  APP_URL: "http://localhost:5173",
  DATABASE_URL: "postgres://crm:crm@localhost:5432/crm",
  SESSION_SECRET: secret("a"),
  TOKEN_ENC_KEY: secret("b"),
  UNSUBSCRIBE_SECRET: secret("c"),
  IP_HASH_SALT: secret("d"),
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

  it("reports cross-variable problems together with field problems", () => {
    const error = errorOf(valid({ FAKE_PROVIDERS: "false", PORT: "http" }));
    expect(error.invalid.has("PORT")).toBe(true);
    expect(error.missing).toContain("OIDC_CLIENT_ID");
  });

  it("requires a non-empty mail allow-list in staging", () => {
    expect(errorOf(valid({ DEPLOY_ENV: "staging" })).missing).toEqual(["MAIL_ALLOWLIST"]);
    expect(errorOf(valid({ DEPLOY_ENV: "staging", MAIL_ALLOWLIST: " , ," })).missing).toEqual(["MAIL_ALLOWLIST"]);
    expect(parseEnv(valid({ DEPLOY_ENV: "staging", MAIL_ALLOWLIST: "qa@soa.example" })).MAIL_ALLOWLIST).toEqual([
      "qa@soa.example",
    ]);
  });

  it.each(["javascript:alert(1)", "mailto:a@soa.example", "ftp://soa.example"])("rejects the URL %s", (url) => {
    expect(errorOf(valid({ PUBLIC_URL: url })).invalid.get("PUBLIC_URL")).toBe("must be an http(s) URL");
  });

  it("requires https URLs in production", () => {
    const error = errorOf(valid({ NODE_ENV: "production", FAKE_PROVIDERS: "false" }));
    expect(error.invalid.get("PUBLIC_URL")).toBe("must use https in production");
    expect(error.invalid.get("APP_URL")).toBe("must use https in production");
  });

  it.each(["1e3", "0x10", "70000", "-1"])("rejects the port %s", (port) => {
    expect(errorOf(valid({ PORT: port })).invalid.has("PORT")).toBe(true);
  });

  it("rejects a database URL without a host and database", () => {
    expect(errorOf(valid({ DATABASE_URL: "postgres://" })).invalid.has("DATABASE_URL")).toBe(true);
  });

  it("requires the four secrets to differ", () => {
    const error = errorOf(valid({ TOKEN_ENC_KEY: secret("A") }));
    expect(error.invalid.get("TOKEN_ENC_KEY")).toBe("must differ from the other secrets");
  });
});
