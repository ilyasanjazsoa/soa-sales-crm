import { createHash } from "node:crypto";
import type { Database, Executor } from "@soa/db";
import {
  defaultPackageFor,
  priceBreakdown,
  type Account,
  type AccountPage,
  type AccountPatch,
  type AccountsQuery,
  type ActivityPage,
  type Contact,
  type ContactInput,
  type ContactPatch,
  type CreateAccountRequest,
  type Signal,
  type SignalInput,
  type SignalPatch,
} from "@soa/shared";
import type { z } from "zod";
import type { Clock } from "../clock";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { accountsRepo, type AccountRow } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import { activitiesRepo, contactsRepo, signalsRepo, suppressionsRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import { systemScope, type UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import { livePricing, recomputeFit, toActivity, toContact, toDeal, toSignal } from "./mappers";

type ActivityPageT = z.infer<typeof ActivityPage>;

const decodeCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(value) && value >= 0 ? value : 0;
};
const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString("base64url");

export function createAccountsService({ db, clock }: { db: Database; clock: Clock }) {
  /** 404 when the account is invisible; 403 when visible but not the caller's to change. */
  const requireEditable = async (tx: Executor, scope: UserScope, id: string): Promise<AccountRow> => {
    const repo = accountsRepo(tx);
    const editable = await repo.getEditable(scope, id);
    if (editable !== undefined) return editable;
    if ((await repo.get(scope, id)) !== undefined) {
      throw forbidden("This account is in the shared pool. Claim it before changing it.");
    }
    throw notFound();
  };

  const emailStatusFor = async (tx: Executor, scope: UserScope, email: string | null | undefined) => {
    if (email === null || email === undefined) return "ok" as const;
    const reason = (await suppressionsRepo(tx).reasons(scope, [email])).get(email.toLowerCase());
    return reason === undefined
      ? ("ok" as const)
      : reason === "bounce"
        ? ("bounced" as const)
        : ("unsubscribed" as const);
  };

  /** A Lead deal valued at the property type's default package (as in the demo). */
  const newLeadDeal = async (tx: Executor, scope: UserScope, account: AccountRow, ownerUserId: string) => {
    const pkg = defaultPackageFor(account.propertyType);
    const pricing = await livePricing(tx, scope, clock());
    const deal = await dealsRepo(tx).insert(scope, {
      accountId: account.id,
      ownerUserId,
      name: `${account.name} security`,
      package: pkg,
      annualValueCents: pricing === null ? 0 : priceBreakdown(pkg, pricing).annualCents,
    });
    if (deal !== undefined) await dealsRepo(tx).recordStage(scope, deal.id, null, "lead");
    return deal;
  };

  const addContactIn = async (tx: Executor, scope: UserScope, account: AccountRow, input: ContactInput) => {
    const contacts = contactsRepo(tx);
    const existing = await contacts.listForAccount(scope, account.id);
    const isPrimary = input.isPrimary ?? existing.length === 0;
    const created = await contacts.insert(scope, {
      accountId: account.id,
      firstName: input.firstName,
      lastName: input.lastName,
      title: input.title ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      phoneType: input.phoneType ?? "unknown",
      linkedinUrl: input.linkedinUrl ?? null,
      contactPref: input.contactPref ?? null,
      isPrimary: false,
      doNotCall: input.doNotCall ?? false,
      emailStatus: await emailStatusFor(tx, scope, input.email),
    });
    if (isPrimary) {
      await contacts.clearPrimary(scope, account.id, created.id);
      return (await contacts.update(scope, created.id, { isPrimary: true })) ?? created;
    }
    return created;
  };

  /** The activity (and, where the rules require it, the audit row) for a change, in the caller's transaction. */
  const record = async (
    tx: Executor,
    scope: UserScope,
    accountId: string,
    subject: string,
    meta: Record<string, unknown> = {},
    audit?: { action: string; entityType: string; entityId: string; ip: string | null },
  ) => {
    await activitiesRepo(tx).insert(scope, { accountId, type: "note", subject, meta: { change: true, ...meta } });
    if (audit !== undefined) {
      await auditRepo(tx).write(scope, {
        action: audit.action,
        entityType: audit.entityType,
        entityId: audit.entityId,
        meta,
        ip: audit.ip,
      });
    }
  };

  const service = {
    async search(scope: UserScope, query: AccountsQuery): Promise<AccountPage> {
      const repo = accountsRepo(db);
      const offset = decodeCursor(query.cursor);
      const rows = await repo.search(scope, { ...query, offset, limit: query.limit });
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((row) => ({
          id: row.account.id,
          name: row.account.name,
          propertyType: row.account.propertyType,
          city: row.account.city,
          ownerCompany: row.account.ownerCompany,
          owner:
            row.account.ownerUserId === null
              ? null
              : { id: row.account.ownerUserId, name: row.ownerName ?? "Former user" },
          fitScore: row.account.fitScore,
          fitReasons: row.account.fitReasons,
          deal:
            row.dealId === null || row.dealStage === null || row.dealStatus === null
              ? null
              : { id: row.dealId, stage: row.dealStage, status: row.dealStatus },
        })),
        nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
        hiddenFromYou: offset === 0 ? await repo.countHidden(scope) : null,
      };
    },

    async get(scope: UserScope, id: string): Promise<Account> {
      const repo = accountsRepo(db);
      const row = await repo.get(scope, id);
      if (row === undefined) throw notFound();
      const [contacts, deal, counts, editable] = await Promise.all([
        contactsRepo(db).listForAccount(scope, id),
        dealsRepo(db).currentForAccount(scope, id),
        repo.counts(scope, id),
        repo.getEditable(scope, id),
      ]);
      const account = row.account;
      return {
        id: account.id,
        name: account.name,
        propertyType: account.propertyType,
        addressLine: account.addressLine,
        city: account.city,
        state: account.state,
        postalCode: account.postalCode,
        ownerCompany: account.ownerCompany,
        sizeText: account.sizeText,
        yearBuilt: account.yearBuilt,
        occupancyPct: account.occupancyPct,
        currentProvider: account.currentProvider,
        contractTiming: account.contractTiming,
        contractEndDate: account.contractEndDate,
        website: account.website,
        isExistingClient: account.isExistingClient,
        doNotContact: account.doNotContact,
        fitScore: account.fitScore,
        fitReasons: account.fitReasons,
        source: account.source,
        owner: account.ownerUserId === null ? null : { id: account.ownerUserId, name: row.ownerName ?? "Former user" },
        createdAt: account.createdAt.toISOString(),
        canEdit: editable !== undefined,
        contacts: contacts.map(toContact),
        deal: deal === undefined ? null : toDeal(deal),
        latestBriefId: counts?.latestBriefId ?? null,
        counts: { signals: counts?.signals ?? 0, sources: counts?.sources ?? 0, openTasks: counts?.openTasks ?? 0 },
      };
    },

    async create(scope: UserScope, body: CreateAccountRequest, ip: string | null): Promise<Account> {
      const id = await db.transaction(async (tx) => {
        const repo = accountsRepo(tx);
        const duplicate = await repo.findDuplicate(systemScope("duplicate check"), body.name, body.city ?? null);
        if (duplicate !== undefined) {
          throw conflict("duplicate", "An account with this name and city already exists.", { id: duplicate.id });
        }
        const { contact, ...fields } = body;
        const account = await repo.insert(scope, {
          ...fields,
          website: fields.website ?? null,
          source: "manual",
          ownerUserId: scope.userId,
          createdBy: scope.userId,
        });
        if (account === undefined) throw conflict("duplicate", "An account with this name and city already exists.");
        if (contact !== undefined) await addContactIn(tx, scope, account, contact);
        await newLeadDeal(tx, scope, account, scope.userId);
        await activitiesRepo(tx).insert(scope, { accountId: account.id, type: "note", subject: "Account created" });
        await auditRepo(tx).write(scope, { action: "account.create", entityType: "account", entityId: account.id, ip });
        await recomputeFit(tx, scope, account.id, clock());
        return account.id;
      });
      return service.get(scope, id);
    },

    async update(scope: UserScope, id: string, patch: AccountPatch, ip: string | null = null): Promise<Account> {
      await db
        .transaction(async (tx) => {
          const current = await requireEditable(tx, scope, id);
          const name = patch.name ?? current.name;
          const city = patch.city === undefined ? current.city : patch.city;
          if (
            name.toLowerCase() !== current.name.toLowerCase() ||
            (city ?? "").toLowerCase() !== (current.city ?? "").toLowerCase()
          ) {
            const duplicate = await accountsRepo(tx).findDuplicate(systemScope("duplicate check"), name, city);
            if (duplicate !== undefined && duplicate.id !== id) {
              throw conflict("duplicate", "An account with this name and city already exists.", { id: duplicate.id });
            }
          }
          await accountsRepo(tx).update(scope, id, patch);
          const fields = Object.keys(patch).sort();
          await record(
            tx,
            scope,
            id,
            "Account details updated",
            { fields },
            {
              action: "account.update",
              entityType: "account",
              entityId: id,
              ip,
            },
          );
          await recomputeFit(tx, scope, id, clock());
        })
        .catch((error: unknown) => {
          // Two renames to the same name and city at once: the dedupe index rejects the second.
          if ((error as { cause?: { code?: string } }).cause?.code === "23505") {
            throw conflict("duplicate", "An account with this name and city already exists.");
          }
          throw error;
        });
      return service.get(scope, id);
    },

    /** Takes an unassigned account. Exactly one claim wins; the rest get 409. */
    async claim(scope: UserScope, id: string, ip: string | null): Promise<Account> {
      await db.transaction(async (tx) => {
        const repo = accountsRepo(tx);
        // Visible when the request started (snapshot read): otherwise this is someone else's account → 404.
        const before = await repo.get(scope, id);
        if (before === undefined) throw notFound();
        const claimed = await repo.claim(scope, id);
        // It was in the pool when we looked, but another rep's claim committed first → 409.
        if (claimed === undefined) throw conflict("already_owned", "Someone has already claimed this account.");
        const reassigned = await dealsRepo(tx).reassignOpen(scope, id, scope.userId);
        if (reassigned.length === 0) await newLeadDeal(tx, scope, claimed, scope.userId);
        await activitiesRepo(tx).insert(scope, {
          accountId: id,
          type: "owner_change",
          subject: "Claimed this account",
          meta: { to: scope.userId },
        });
        await auditRepo(tx).write(scope, { action: "account.claim", entityType: "account", entityId: id, ip });
      });
      return service.get(scope, id);
    },

    /** Managers: set or clear the owner. */
    async assign(scope: UserScope, id: string, ownerUserId: string | null, ip: string | null): Promise<Account> {
      await db.transaction(async (tx) => {
        const current = await requireEditable(tx, scope, id);
        if (ownerUserId !== null) {
          const owner = await usersRepo(tx).findById(systemScope("assign target"), ownerUserId);
          if (!owner?.active) throw unprocessable("invalid_owner", "Choose an active user.");
        }
        await accountsRepo(tx).setOwner(scope, id, ownerUserId);
        if (ownerUserId !== null) {
          const moved = await dealsRepo(tx).reassignOpen(scope, id, ownerUserId);
          if (moved.length === 0 && current.ownerUserId === null) {
            await newLeadDeal(tx, scope, { ...current, ownerUserId }, ownerUserId);
          }
        }
        await activitiesRepo(tx).insert(scope, {
          accountId: id,
          type: "owner_change",
          subject: ownerUserId === null ? "Returned to the shared pool" : "Reassigned",
          meta: { from: current.ownerUserId, to: ownerUserId },
        });
        await auditRepo(tx).write(scope, {
          action: "account.assign",
          entityType: "account",
          entityId: id,
          meta: { from: current.ownerUserId, to: ownerUserId },
          ip,
        });
      });
      return service.get(scope, id);
    },

    async remove(scope: UserScope, id: string, purge: boolean, ip: string | null): Promise<void> {
      await db.transaction(async (tx) => {
        if (purge) {
          // Purge also works on soft-deleted accounts (the usual order: delete, then purge).
          if (scope.role === "ae") throw forbidden("Only a manager can permanently delete an account.");
          if (!(await accountsRepo(tx).purge(scope, id))) throw notFound();
          await auditRepo(tx).write(scope, { action: "account.purge", entityType: "account", entityId: id, ip });
          return;
        }
        await requireEditable(tx, scope, id);
        await accountsRepo(tx).softDelete(scope, id);
        await record(
          tx,
          scope,
          id,
          "Account deleted",
          {},
          { action: "account.delete", entityType: "account", entityId: id, ip },
        );
      });
    },

    // ───────── contacts ─────────
    async addContact(scope: UserScope, accountId: string, input: ContactInput): Promise<Contact> {
      return db.transaction(async (tx) => {
        const account = await requireEditable(tx, scope, accountId);
        const created = await addContactIn(tx, scope, account, input);
        await record(tx, scope, accountId, `Contact added: ${created.firstName} ${created.lastName}`.trim(), {
          contactId: created.id,
        });
        await recomputeFit(tx, scope, accountId, clock());
        return toContact(created);
      });
    },

    async updateContact(scope: UserScope, id: string, patch: ContactPatch): Promise<Contact> {
      return db.transaction(async (tx) => {
        const contacts = contactsRepo(tx);
        const current = await contacts.getEditable(scope, id);
        if (current === undefined) {
          if ((await contacts.get(scope, id)) !== undefined) throw forbidden("Claim this account before changing it.");
          throw notFound();
        }
        const values: Record<string, unknown> = { ...patch };
        if (patch.email !== undefined) values.emailStatus = await emailStatusFor(tx, scope, patch.email);
        if (patch.isPrimary === true) await contacts.clearPrimary(scope, current.accountId, id);
        const updated = await contacts.update(scope, id, values);
        if (updated === undefined) throw notFound();
        await record(tx, scope, current.accountId, `Contact updated: ${updated.firstName} ${updated.lastName}`.trim(), {
          contactId: id,
          fields: Object.keys(patch).sort(),
        });
        await recomputeFit(tx, scope, current.accountId, clock());
        return toContact(updated);
      });
    },

    async deleteContact(scope: UserScope, id: string): Promise<void> {
      await db.transaction(async (tx) => {
        const deleted = await contactsRepo(tx).delete(scope, id);
        if (deleted === undefined) throw notFound();
        await record(tx, scope, deleted.accountId, `Contact removed: ${deleted.firstName} ${deleted.lastName}`.trim());
        await recomputeFit(tx, scope, deleted.accountId, clock());
      });
    },

    /** Managers: remove a contact's personal details. Any suppression of the address stays (§15). */
    async eraseContact(scope: UserScope, id: string, ip: string | null): Promise<Contact> {
      return db.transaction(async (tx) => {
        const contacts = contactsRepo(tx);
        const current = await contacts.getEditable(scope, id);
        if (current === undefined) throw notFound();
        const erased = await contacts.update(scope, id, {
          firstName: "Erased",
          lastName: "",
          title: null,
          email: null,
          phone: null,
          linkedinUrl: null,
          contactPref: null,
          isPrimary: false,
          doNotCall: true,
        });
        if (erased === undefined) throw notFound();
        await record(
          tx,
          scope,
          current.accountId,
          "Contact details erased",
          { contactId: id },
          {
            action: "contact.erase",
            entityType: "contact",
            entityId: id,
            ip,
          },
        );
        await recomputeFit(tx, scope, current.accountId, clock());
        return toContact(erased);
      });
    },

    // ───────── signals ─────────
    async listSignals(scope: UserScope, accountId: string): Promise<Signal[]> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      return (await signalsRepo(db).listForAccount(scope, accountId)).map(toSignal);
    },

    async addSignal(scope: UserScope, accountId: string, input: SignalInput): Promise<Signal> {
      return db.transaction(async (tx) => {
        await requireEditable(tx, scope, accountId);
        const created = await signalsRepo(tx).insert(scope, {
          accountId,
          text: input.text,
          kind: input.kind,
          observedOn: input.observedOn ?? null,
          confirmed: true, // entered by a person
          createdBy: scope.userId,
        });
        await record(tx, scope, accountId, `Signal added: ${created.text}`, { signalId: created.id });
        await recomputeFit(tx, scope, accountId, clock());
        return toSignal(created);
      });
    },

    async updateSignal(scope: UserScope, id: string, patch: SignalPatch): Promise<Signal> {
      return db.transaction(async (tx) => {
        const updated = await signalsRepo(tx).update(scope, id, patch);
        if (updated === undefined) throw notFound();
        await record(
          tx,
          scope,
          updated.accountId,
          `${patch.confirmed === true ? "Signal confirmed" : "Signal updated"}: ${updated.text}`,
          {
            signalId: id,
          },
        );
        await recomputeFit(tx, scope, updated.accountId, clock());
        return toSignal(updated);
      });
    },

    async deleteSignal(scope: UserScope, id: string): Promise<void> {
      await db.transaction(async (tx) => {
        const deleted = await signalsRepo(tx).delete(scope, id);
        if (deleted === undefined) throw notFound();
        await record(tx, scope, deleted.accountId, `Signal removed: ${deleted.text}`, { signalId: id });
        await recomputeFit(tx, scope, deleted.accountId, clock());
      });
    },

    // ───────── timeline ─────────
    async timeline(
      scope: UserScope,
      accountId: string,
      cursor: string | undefined,
      limit: number,
    ): Promise<ActivityPageT> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      if (cursor !== undefined && !UUID.test(cursor)) throw badRequest("That page link is not valid.");
      const rows = await activitiesRepo(db).timeline(scope, accountId, cursor, limit);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toActivity),
        nextCursor: rows.length > limit && last !== undefined ? last.activity.id : null,
      };
    },

    async addNote(scope: UserScope, accountId: string, text: string): Promise<void> {
      await db.transaction(async (tx) => {
        await requireEditable(tx, scope, accountId);
        await activitiesRepo(tx).insert(scope, { accountId, type: "note", body: text });
        await dealsRepo(tx).touch(scope, accountId);
      });
    },
  };
  return service;
}

export type AccountsService = ReturnType<typeof createAccountsService>;

export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");
