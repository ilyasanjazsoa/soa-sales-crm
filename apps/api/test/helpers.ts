import { randomBytes } from "node:crypto";

/** A complete, fictional test configuration. The database matches docker-compose.yml and the CI service. */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const secret = () => randomBytes(32).toString("hex");
  return {
    NODE_ENV: "test",
    PORT: "0",
    PUBLIC_URL: "http://localhost:3000",
    APP_URL: "http://localhost:5173",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://crm:crm@localhost:5432/crm",
    SESSION_SECRET: secret(),
    TOKEN_ENC_KEY: secret(),
    UNSUBSCRIBE_SECRET: secret(),
    IP_HASH_SALT: secret(),
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
  };
}
