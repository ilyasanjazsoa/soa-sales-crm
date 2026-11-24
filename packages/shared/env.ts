import { z } from "zod";

/* Configuration from docs/API.md §Configuration. Pure: callers pass the variables in (usually process.env).
   Error messages name variables but never include their values. Every problem is reported at once. */

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const required = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const secret = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes written as 64 hex characters (pnpm env:init generates one)")
  .transform((value) => value.toLowerCase());
const httpUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.hostname, error: "must be an http(s) URL" });
const email = z.email({ error: "must be an email address" }).toLowerCase();
const emailList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.email({ error: "must be a comma-separated list of email addresses" })));
const databaseUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return /^postgres(ql)?:$/.test(url.protocol) && url.hostname !== "" && url.pathname.length > 1;
  } catch {
    return false;
  }
}, "must be a postgres:// connection string with a host and database name");

/** Needed only when real providers are used (FAKE_PROVIDERS=false). */
export const REAL_PROVIDER_VARIABLES = [
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "MAPS_PROVIDER",
  "MAPS_API_KEY",
  "ESIGN_PROVIDER",
  "ESIGN_API_KEY",
  "ESIGN_WEBHOOK_SECRET",
  "ESIGN_TEMPLATE_ID",
] as const;

const SECRET_VARIABLES = ["SESSION_SECRET", "TOKEN_ENC_KEY", "UNSUBSCRIBE_SECRET", "IP_HASH_SALT"] as const;

const EnvSchema = z.object({
  NODE_ENV: required(z.enum(["development", "test", "production"])),
  /** Which deployment this is. `staging` requires MAIL_ALLOWLIST so staging can never email real prospects. */
  DEPLOY_ENV: optional(z.enum(["local", "ci", "staging", "production"])),
  PORT: required(
    z
      .string()
      .regex(/^\d{1,5}$/, "must be a port number")
      .transform(Number)
      .pipe(z.number().max(65535, "must be a port number")),
  ),
  LOG_LEVEL: optional(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])),
  PUBLIC_URL: required(httpUrl),
  APP_URL: required(httpUrl),
  DATABASE_URL: required(databaseUrl),
  SESSION_SECRET: required(secret),
  TOKEN_ENC_KEY: required(secret),
  UNSUBSCRIBE_SECRET: required(secret),
  IP_HASH_SALT: required(secret),
  IDP: required(z.enum(["microsoft", "google"])),
  OIDC_CLIENT_ID: optional(z.string()),
  OIDC_CLIENT_SECRET: optional(z.string()),
  OIDC_TENANT_ID: optional(z.string()),
  ALLOWED_EMAIL_DOMAIN: required(
    z
      .string()
      .toLowerCase()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "must be a domain such as company.com"),
  ),
  BOOTSTRAP_ADMIN_EMAIL: required(email),
  AWS_REGION: required(z.string()),
  AI_MODEL_WRITER: required(z.string()),
  AI_MODEL_FAST: required(z.string()),
  S3_BUCKET: required(z.string()),
  S3_ENDPOINT: optional(httpUrl),
  MAPS_PROVIDER: optional(z.enum(["google"])),
  MAPS_API_KEY: optional(z.string()),
  ESIGN_PROVIDER: optional(z.enum(["dropbox_sign"])),
  ESIGN_API_KEY: optional(z.string()),
  ESIGN_WEBHOOK_SECRET: optional(z.string()),
  ESIGN_TEMPLATE_ID: optional(z.string()),
  COMPANY_NAME: required(z.string()),
  COMPANY_POSTAL_ADDRESS: optional(z.string()),
  COMPANY_SIGNER_NAME: optional(z.string()),
  COMPANY_SIGNER_EMAIL: optional(email),
  MAIL_ALLOWLIST: optional(emailList),
  FAKE_PROVIDERS: required(
    z.enum(["true", "false"], { error: "must be true or false" }).transform((value) => value === "true"),
  ),
});

export type Env = z.output<typeof EnvSchema>;
export type EnvSource = Readonly<Record<string, string | undefined>>;

export class EnvError extends Error {
  constructor(
    readonly missing: readonly string[],
    readonly invalid: ReadonlyMap<string, string>,
  ) {
    const lines = ["Configuration error. Fix these environment variables and start again:"];
    if (missing.length > 0) lines.push(`  Missing required variable(s): ${missing.join(", ")}`);
    for (const [key, message] of invalid) lines.push(`  ${key} ${message}`);
    super(lines.join("\n"));
    this.name = "EnvError";
  }
}

const present = (source: EnvSource, key: string) => blankToUndefined(source[key]) !== undefined;

/** Rules across variables. They read the raw values so they run even when other variables are invalid. */
function crossFieldProblems(source: EnvSource): { missing: string[]; invalid: [string, string][] } {
  const missing: string[] = [];
  const invalid: [string, string][] = [];
  const raw = (key: string) => blankToUndefined(source[key]) as string | undefined;
  const production = raw("NODE_ENV") === "production";
  const fakes = raw("FAKE_PROVIDERS") === "true";

  if (production && fakes) invalid.push(["FAKE_PROVIDERS", "must be false in production"]);
  if (production) {
    for (const key of ["PUBLIC_URL", "APP_URL"]) {
      if (raw(key)?.startsWith("http://")) invalid.push([key, "must use https in production"]);
    }
  }
  if (raw("DEPLOY_ENV") === "staging") {
    const list = raw("MAIL_ALLOWLIST")
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (list === undefined || list.length === 0) missing.push("MAIL_ALLOWLIST");
  }

  const domain = raw("ALLOWED_EMAIL_DOMAIN")?.toLowerCase();
  const admin = raw("BOOTSTRAP_ADMIN_EMAIL")?.toLowerCase();
  if (domain !== undefined && admin !== undefined && !admin.endsWith(`@${domain}`)) {
    invalid.push(["BOOTSTRAP_ADMIN_EMAIL", "must be in ALLOWED_EMAIL_DOMAIN"]);
  }

  const secrets = SECRET_VARIABLES.map((key) => [key, raw(key)?.toLowerCase()] as const).filter(
    (entry): entry is readonly [(typeof SECRET_VARIABLES)[number], string] => entry[1] !== undefined,
  );
  for (const [index, [key, value]] of secrets.entries()) {
    if (secrets.slice(0, index).some(([, other]) => other === value)) {
      invalid.push([key, "must differ from the other secrets"]);
    }
  }

  if (raw("FAKE_PROVIDERS") === "false") {
    const needed: string[] = [...REAL_PROVIDER_VARIABLES];
    if (raw("IDP") === "microsoft") needed.push("OIDC_TENANT_ID");
    for (const key of needed) if (!present(source, key)) missing.push(key);
  }
  return { missing, invalid };
}

export function parseEnv(source: EnvSource): Env {
  const result = EnvSchema.safeParse(source);
  const cross = crossFieldProblems(source);
  if (result.success && cross.missing.length === 0 && cross.invalid.length === 0) return result.data;

  const missing = new Set<string>(cross.missing);
  const invalid = new Map<string, string>();
  for (const issue of result.error?.issues ?? []) {
    const key = typeof issue.path[0] === "string" ? issue.path[0] : "(environment)";
    if (!present(source, key)) missing.add(key);
    else if (!invalid.has(key)) invalid.set(key, issue.message);
  }
  for (const [key, message] of cross.invalid) if (!invalid.has(key)) invalid.set(key, message);
  throw new EnvError([...missing].sort(), invalid);
}
