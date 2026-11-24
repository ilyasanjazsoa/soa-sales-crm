import { tables } from "@soa/db";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Scope } from "./scope";

const { accounts, deals } = tables;

/* The visibility rule (ARCHITECTURE.md §4), in one place:
   visible(account, user) = role in (manager, admin) OR owner = user OR owner IS NULL; never soft-deleted.
   Child rows (contacts, signals, deals, activities, tasks…) are visible when their account is. */

/** AND of conditions as a definite SQL fragment (drizzle's and() is typed as possibly undefined). */
export function allOf(...conditions: (SQL | undefined)[]): SQL {
  return and(...conditions) ?? sql`true`;
}

/** OR of conditions as a definite SQL fragment. */
export function anyOf(...conditions: (SQL | undefined)[]): SQL {
  return or(...conditions) ?? sql`false`;
}

export function accountVisible(scope: Scope): SQL {
  const live = isNull(accounts.deletedAt);
  if (scope.kind === "system" || scope.role !== "ae") return live;
  return allOf(live, anyOf(eq(accounts.ownerUserId, scope.userId), isNull(accounts.ownerUserId)));
}

/** Accounts the scope may change: managers any live account, AEs only their own. */
export function accountEditable(scope: Scope): SQL {
  const live = isNull(accounts.deletedAt);
  if (scope.kind === "system" || scope.role !== "ae") return live;
  return allOf(live, eq(accounts.ownerUserId, scope.userId));
}

/** Deals the scope may change: managers any, AEs only deals they own on accounts they can see. */
export function dealEditable(scope: Scope): SQL {
  if (scope.kind === "system" || scope.role !== "ae") return isNull(accounts.deletedAt);
  return allOf(accountVisible(scope), eq(deals.ownerUserId, scope.userId));
}
