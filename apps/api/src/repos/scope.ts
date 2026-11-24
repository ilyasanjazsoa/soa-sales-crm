import type { Role } from "@soa/shared";

/* Every repo function takes a Scope first (ARCHITECTURE.md §4, CLAUDE.md rule 1). Visibility is enforced in the
   repos and nowhere else. A SystemScope is used only by code that runs before a user is known (sign-in) or on
   the system's behalf (jobs, webhooks), and always names why. */

export interface UserScope {
  readonly kind: "user";
  readonly userId: string;
  readonly role: Role;
}

export interface SystemScope {
  readonly kind: "system";
  readonly reason: string;
}

export type Scope = UserScope | SystemScope;

export const userScope = (userId: string, role: Role): UserScope => ({ kind: "user", userId, role });

export const systemScope = (reason: string): SystemScope => ({ kind: "system", reason });

/** Managers and admins see every account and deal (§4). */
export const seesEverything = (scope: Scope): boolean => scope.kind === "system" || scope.role !== "ae";

export const isAdmin = (scope: Scope): boolean => scope.kind === "system" || scope.role === "admin";

/** The acting user's id for audit and authorship columns; null for the system. */
export const actorId = (scope: Scope): string | null => (scope.kind === "user" ? scope.userId : null);
