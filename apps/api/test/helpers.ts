import { randomBytes } from "node:crypto";
import { parseEnv, type Role } from "@soa/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { testDatabaseUrl } from "./db-setup";
import { buildApp, type BuildAppOptions } from "../src/app";
import type { Clock } from "../src/clock";

/** A complete, fictional test configuration pointing at the run's throwaway database. */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const secret = () => randomBytes(32).toString("hex");
  return {
    NODE_ENV: "test",
    PORT: "0",
    PUBLIC_URL: "http://localhost:3000",
    APP_URL: "http://localhost:5173",
    DATABASE_URL: testDatabaseUrl(),
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

/** A clock the test can move. */
export function fakeClock(start = new Date("2026-03-02T15:00:00Z")) {
  let now = start.getTime();
  const clock: Clock = () => new Date(now);
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export async function testApp(options: Partial<BuildAppOptions> & { env?: Record<string, string> } = {}) {
  const { env, ...rest } = options;
  return buildApp({ config: parseEnv(testEnv(env)), logger: false, ...rest });
}

/** A direct connection as the schema owner, for arranging data and inspecting raw rows. */
export async function ownerQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Empties every application table. */
export async function resetDatabase(): Promise<void> {
  const tables = await ownerQuery<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const list = tables.map((row) => `"${row.tablename}"`).join(", ");
  await ownerQuery(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export interface TestUser {
  id: string;
  email: string;
  role: Role;
}

export async function createUser(
  email: string,
  role: Role = "ae",
  options: { active?: boolean; name?: string } = {},
): Promise<TestUser> {
  const [row] = await ownerQuery<{ id: string }>(
    "INSERT INTO users (email, name, role, active) VALUES ($1, $2, $3, $4) RETURNING id",
    [email, options.name ?? email.split("@")[0], role, options.active ?? true],
  );
  if (row === undefined) throw new Error("user not created");
  return { id: row.id, email, role };
}

export async function createAccount(name: string, ownerUserId: string | null): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    "INSERT INTO accounts (name, property_type, city, owner_user_id) VALUES ($1, 'Industrial', 'Irving', $2) RETURNING id",
    [name, ownerUserId],
  );
  if (row === undefined) throw new Error("account not created");
  return row.id;
}

const cookieValue = (response: LightMyRequestResponse, name: string) =>
  response.cookies.find((cookie) => cookie.name === name)?.value;

export interface SignedIn {
  sid: string;
  csrf: string;
  /** Cookies for app.inject. */
  cookies: Record<string, string>;
  /** Headers for state-changing requests. */
  headers: Record<string, string>;
  callback: LightMyRequestResponse;
}

/** Runs the whole sign-in flow through the fake identity provider. Returns the callback response either way. */
export async function attemptSignIn(app: FastifyInstance, email: string): Promise<LightMyRequestResponse> {
  const login = await app.inject({ method: "GET", url: "/api/auth/login" });
  const stateCookie = cookieValue(login, "login_state");
  const location = new URL(String(login.headers.location));
  if (stateCookie === undefined) throw new Error("no login state cookie");

  const form = new URLSearchParams(location.searchParams);
  form.set("other_email", email);
  const idp = await app.inject({
    method: "POST",
    url: location.pathname,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form.toString(),
  });
  const callback = new URL(String(idp.headers.location));
  return app.inject({
    method: "GET",
    url: `${callback.pathname}${callback.search}`,
    cookies: { login_state: stateCookie },
  });
}

export async function signIn(app: FastifyInstance, email: string): Promise<SignedIn> {
  const callback = await attemptSignIn(app, email);
  const sid = cookieValue(callback, "sid");
  const csrf = cookieValue(callback, "csrf");
  if (sid === undefined || csrf === undefined) {
    throw new Error(`sign-in failed for ${email}: ${String(callback.headers.location)}`);
  }
  return { sid, csrf, cookies: { sid }, headers: { "x-csrf-token": csrf }, callback };
}
