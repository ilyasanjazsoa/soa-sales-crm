import { z } from "zod";

/* Configuration from docs/API.md §Configuration. Pure: callers pass the variables in (usually process.env).
   Error messages name variables but never include their values. */

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const required = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const secret = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes written as 64 hex characters (pnpm env:init generates one)");
const url = z.url({ error: "must be a URL" });
const emailList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.email({ error: "must be a comma-separated list of email addresses" })));

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

const EnvSchema = z
  .object({
    NODE_ENV: required(z.enum(["development", "test", "production"])),
    PORT: required(z.coerce.number().int().min(0).max(65535)),
    PUBLIC_URL: required(url),
    APP_URL: required(url),
    DATABASE_URL: required(z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string")),
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
    BOOTSTRAP_ADMIN_EMAIL: required(z.email({ error: "must be an email address" }).toLowerCase()),
    AWS_REGION: required(z.string()),
    AI_MODEL_WRITER: required(z.string()),
    AI_MODEL_FAST: required(z.string()),
    S3_BUCKET: required(z.string()),
    S3_ENDPOINT: optional(url),
    MAPS_PROVIDER: optional(z.enum(["google"])),
    MAPS_API_KEY: optional(z.string()),
    ESIGN_PROVIDER: optional(z.enum(["dropbox_sign"])),
    ESIGN_API_KEY: optional(z.string()),
    ESIGN_WEBHOOK_SECRET: optional(z.string()),
    ESIGN_TEMPLATE_ID: optional(z.string()),
    COMPANY_NAME: required(z.string()),
    COMPANY_POSTAL_ADDRESS: optional(z.string()),
    COMPANY_SIGNER_NAME: optional(z.string()),
    COMPANY_SIGNER_EMAIL: optional(z.email({ error: "must be an email address" })),
    MAIL_ALLOWLIST: optional(emailList),
    FAKE_PROVIDERS: required(
      z.enum(["true", "false"], { error: "must be true or false" }).transform((value) => value === "true"),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.FAKE_PROVIDERS) {
      ctx.addIssue({ code: "custom", path: ["FAKE_PROVIDERS"], message: "must be false in production" });
    }
    if (!env.BOOTSTRAP_ADMIN_EMAIL.endsWith(`@${env.ALLOWED_EMAIL_DOMAIN}`)) {
      ctx.addIssue({ code: "custom", path: ["BOOTSTRAP_ADMIN_EMAIL"], message: "must be in ALLOWED_EMAIL_DOMAIN" });
    }
    if (env.FAKE_PROVIDERS) return;
    const needed: string[] = [...REAL_PROVIDER_VARIABLES];
    if (env.IDP === "microsoft") needed.push("OIDC_TENANT_ID");
    for (const key of needed) {
      if ((env as Record<string, unknown>)[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "is required when FAKE_PROVIDERS=false" });
      }
    }
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

export function parseEnv(source: EnvSource): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const missing = new Set<string>();
  const invalid = new Map<string, string>();
  for (const issue of result.error.issues) {
    const key = typeof issue.path[0] === "string" ? issue.path[0] : "(environment)";
    if (blankToUndefined(source[key]) === undefined) missing.add(key);
    else if (!invalid.has(key)) invalid.set(key, issue.message);
  }
  throw new EnvError([...missing].sort(), invalid);
}
