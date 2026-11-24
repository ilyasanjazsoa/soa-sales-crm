import { z } from "zod";

/* Request and response shapes shared by the api and the web app (ARCHITECTURE.md §13).
   Errors: { error: { code, message, details? } } with 400, 401, 403, 404, 409, 422, 429. */

export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const HealthResponse = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ReadyResponse = z.object({
  status: z.enum(["ok", "unavailable"]),
  checks: z.object({ database: z.enum(["up", "down"]) }),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;

// ───────── users and profile ─────────
export const Role = z.enum(["ae", "manager", "admin"]);
export type Role = z.infer<typeof Role>;

export const ROLE_LABELS: Record<Role, string> = { ae: "Account executive", manager: "Manager", admin: "Admin" };

/** "HH:MM" on a 24-hour clock. */
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time such as 08:30");

export const TimeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}, "must be an IANA time zone such as America/Chicago");

export const UserProfile = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  title: z.string(),
  phone: z.string().nullable(),
  role: Role,
  timezone: z.string(),
  baseAddress: z.string().nullable(),
  workdayStart: TimeOfDay,
  workdayEnd: TimeOfDay,
});
export type UserProfile = z.infer<typeof UserProfile>;

export const MailConnection = z.object({
  provider: z.enum(["microsoft", "google"]).nullable(),
  connected: z.boolean(),
  needsReconnect: z.boolean(),
});
export type MailConnection = z.infer<typeof MailConnection>;

export const MeResponse = z.object({ user: UserProfile, mail: MailConnection, csrfToken: z.string() });
export type MeResponse = z.infer<typeof MeResponse>;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const UpdateMeRequest = z
  .object({
    name: trimmed(120),
    title: trimmed(120),
    phone: z.string().trim().max(40).nullable(),
    timezone: TimeZone,
    baseAddress: z.string().trim().max(300).nullable(),
    workdayStart: TimeOfDay,
    workdayEnd: TimeOfDay,
  })
  .partial()
  .strict()
  .refine(
    (body) => body.workdayStart === undefined || body.workdayEnd === undefined || body.workdayStart < body.workdayEnd,
    { error: "workdayStart must be before workdayEnd", path: ["workdayEnd"] },
  );
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

export const AdminUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  title: z.string(),
  role: Role,
  dailySendCap: z.number().int(),
  active: z.boolean(),
  ownedAccounts: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AssignableUsers = z.object({ items: z.array(z.object({ id: z.uuid(), name: z.string(), role: Role })) });
export type AssignableUsers = z.infer<typeof AssignableUsers>;

export const AdminUserList = z.object({ items: z.array(AdminUser) });
export type AdminUserList = z.infer<typeof AdminUserList>;

export const CreateUserRequest = z
  .object({
    email: z.email().toLowerCase(),
    name: trimmed(120),
    title: trimmed(120).optional(),
    role: Role.default("ae"),
    dailySendCap: z.number().int().min(0).max(500).optional(),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UpdateUserRequest = z
  .object({
    name: trimmed(120),
    title: trimmed(120),
    role: Role,
    dailySendCap: z.number().int().min(0).max(500),
    active: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const IdParam = z.object({ id: z.uuid() });
