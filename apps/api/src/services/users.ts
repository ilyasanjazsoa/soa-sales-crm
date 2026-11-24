import type { Database } from "@soa/db";
import type {
  AdminUser,
  CreateUserRequest,
  Env,
  MeResponse,
  UpdateMeRequest,
  UpdateUserRequest,
  UserProfile,
} from "@soa/shared";
import { conflict, notFound, unprocessable } from "../errors";
import { auditRepo } from "../repos/audit";
import { authRepo } from "../repos/auth";
import type { UserScope } from "../repos/scope";
import { usersRepo, type ProfilePatch, type UserRow } from "../repos/users";

const hhmm = (time: string) => time.slice(0, 5);

export function toProfile(user: UserRow): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title,
    phone: user.phone,
    role: user.role,
    timezone: user.timezone,
    baseAddress: user.baseAddress,
    workdayStart: hhmm(user.workdayStart),
    workdayEnd: hhmm(user.workdayEnd),
  };
}

function toAdminUser(user: UserRow & { ownedAccounts: number }): AdminUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title,
    role: user.role,
    dailySendCap: user.dailySendCap,
    active: user.active,
    ownedAccounts: user.ownedAccounts,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Field names that changed, for the audit log. */
const changedFields = (patch: object) => Object.keys(patch).sort();

export function createUsersService({ db, config }: { db: Database; config: Env }) {
  return {
    async me(scope: UserScope, csrfToken: string): Promise<MeResponse> {
      const user = await usersRepo(db).findById(scope, scope.userId);
      if (user === undefined) throw notFound();
      const mail = await authRepo(db).mailConnection(scope);
      return {
        user: toProfile(user),
        mail: {
          provider: mail?.provider ?? null,
          connected: mail !== undefined && !mail.needsReconnect,
          needsReconnect: mail?.needsReconnect ?? false,
        },
        csrfToken,
      };
    },

    async updateProfile(scope: UserScope, body: UpdateMeRequest, ip: string | null): Promise<UserProfile> {
      return db.transaction(async (tx) => {
        const users = usersRepo(tx);
        const current = await users.findById(scope, scope.userId);
        if (current === undefined) throw notFound();
        const start = body.workdayStart ?? hhmm(current.workdayStart);
        const end = body.workdayEnd ?? hhmm(current.workdayEnd);
        if (start >= end) throw unprocessable("invalid_hours", "The workday must start before it ends.");
        const patch: ProfilePatch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.title !== undefined) patch.title = body.title;
        if (body.phone !== undefined) patch.phone = body.phone === "" ? null : body.phone;
        if (body.timezone !== undefined) patch.timezone = body.timezone;
        if (body.baseAddress !== undefined) {
          patch.baseAddress = body.baseAddress === "" ? null : body.baseAddress;
        }
        if (body.workdayStart !== undefined) patch.workdayStart = body.workdayStart;
        if (body.workdayEnd !== undefined) patch.workdayEnd = body.workdayEnd;
        const updated = await users.updateSelf(scope, patch);
        if (updated === undefined) throw notFound();
        await auditRepo(tx).write(scope, {
          action: "user.profile",
          entityType: "user",
          entityId: scope.userId,
          meta: { fields: changedFields(patch) },
          ip,
        });
        return toProfile(updated);
      });
    },

    async list(scope: UserScope): Promise<AdminUser[]> {
      return (await usersRepo(db).listWithAccountCounts(scope)).map(toAdminUser);
    },

    async create(scope: UserScope, body: CreateUserRequest, ip: string | null): Promise<AdminUser> {
      if (!body.email.endsWith(`@${config.ALLOWED_EMAIL_DOMAIN}`)) {
        throw unprocessable("wrong_domain", `Only ${config.ALLOWED_EMAIL_DOMAIN} addresses can sign in.`);
      }
      return db.transaction(async (tx) => {
        const users = usersRepo(tx);
        const existing = await users.findByEmail({ kind: "system", reason: "duplicate check" }, body.email);
        if (existing !== undefined)
          throw conflict("duplicate", "A user with this email already exists.", { id: existing.id });
        const created = await users.insert(scope, body);
        await auditRepo(tx).write(scope, {
          action: "user.create",
          entityType: "user",
          entityId: created.id,
          meta: { role: created.role },
          ip,
        });
        return toAdminUser({ ...created, ownedAccounts: 0 });
      });
    },

    async update(scope: UserScope, id: string, body: UpdateUserRequest, ip: string | null): Promise<AdminUser> {
      return db.transaction(async (tx) => {
        const users = usersRepo(tx);
        const current = await users.findById(scope, id);
        if (current === undefined) throw notFound();
        const self = id === scope.userId;
        if (self && (body.active === false || (body.role !== undefined && body.role !== current.role))) {
          throw unprocessable("cannot_change_self", "You can't deactivate yourself or change your own role.");
        }
        const losesAdmin =
          current.role === "admin" && current.active && (body.active === false || (body.role ?? "admin") !== "admin");
        if (losesAdmin && (await users.countActiveAdmins(scope)) <= 1) {
          throw unprocessable("last_admin", "Keep at least one active admin.");
        }
        if (body.active === false && current.active) {
          const owned = await users.countOwnedAccounts(scope, id);
          if (owned > 0) {
            throw conflict("reassign_required", `Reassign ${current.name}'s ${owned} accounts before deactivating.`, {
              ownedAccounts: owned,
            });
          }
          await authRepo(tx).deleteSessionsForUser(scope, id);
        }
        const updated = await users.update(scope, id, body);
        if (updated === undefined) throw notFound();
        await auditRepo(tx).write(scope, {
          action: "user.update",
          entityType: "user",
          entityId: id,
          meta: {
            fields: changedFields(body),
            ...(body.role === undefined ? {} : { role: body.role }),
            ...(body.active === undefined ? {} : { active: body.active }),
          },
          ip,
        });
        const ownedAccounts = await users.countOwnedAccounts(scope, id);
        return toAdminUser({ ...updated, ownedAccounts });
      });
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
