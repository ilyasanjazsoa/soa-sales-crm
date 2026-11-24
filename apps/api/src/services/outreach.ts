import type { Database, Executor } from "@soa/db";
import {
  blockingFailures,
  CheckResult,
  ClaimCheckOutput,
  draftProblems,
  emailFooter,
  OutreachDraftOutput,
  runChecks,
  type CreateDraftRequest,
  type Draft,
  type DraftList,
  type DraftPatch,
  type EmailMessage,
  type Env,
  type ReplyClass,
  type Suppression,
} from "@soa/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../clock";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors";
import { JOBS, type JobQueue } from "../jobs/queue";
import type { AiClient } from "../providers/ai/client";
import { claimCheckPrompt, outreachDraftPrompt } from "../providers/ai/prompts";
import { accountsRepo } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import { authRepo } from "../repos/auth";
import { activitiesRepo, contactsRepo, signalsRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import {
  contactEmailRepo,
  draftsRepo,
  emailsRepo,
  suppressionListRepo,
  type DraftRow,
  type EmailRow,
} from "../repos/outreach";
import { referencesRepo } from "../repos/research";
import { systemScope, type UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import { advanceDeal } from "./advance";
import { isoDay } from "./mappers";
import { readUnsubscribeToken, unsubscribeUrl } from "./unsubscribe";

/* Outreach (ARCHITECTURE.md §8). The send route below is the only code path that sends email (CLAUDE.md rule 2):
   it queues one message per click, and the mail.send job is the only caller of MailProvider.send. */

type ContactRow = Awaited<ReturnType<ReturnType<typeof contactsRepo>["listForAccount"]>>[number];
type OutreachConfig = Pick<
  Env,
  "COMPANY_NAME" | "COMPANY_POSTAL_ADDRESS" | "PUBLIC_URL" | "UNSUBSCRIBE_SECRET" | "MAIL_ALLOWLIST" | "DEPLOY_ENV"
>;

const DAY_MS = 24 * 60 * 60 * 1000;
const tooManySends = (cap: number) =>
  new HttpError(429, "send_limit", `You've reached your limit of ${String(cap)} emails in 24 hours. Try again later.`);

const contactName = (contact: ContactRow) => `${contact.firstName} ${contact.lastName}`.trim();

/** MAIL_ALLOWLIST applies whenever it is set (staging must set it, §16). */
export const mailAllowlist = (config: Pick<Env, "MAIL_ALLOWLIST">): string[] | null =>
  config.MAIL_ALLOWLIST === undefined || config.MAIL_ALLOWLIST.length === 0
    ? null
    : config.MAIL_ALLOWLIST.map((address) => address.toLowerCase());

const toEmailMessage = (row: EmailRow): EmailMessage => ({
  id: row.id,
  direction: row.direction,
  status: row.status,
  fromEmail: row.fromEmail,
  toEmail: row.toEmail,
  subject: row.subject,
  bodyText: row.bodyText,
  error: row.error,
  classification: (row.aiClassification as ReplyClass | null) ?? null,
  at: (row.receivedAt ?? row.sentAt ?? row.createdAt).toISOString(),
});

export function createOutreachService(deps: {
  db: Database;
  queue: JobQueue;
  ai: AiClient;
  config: OutreachConfig;
  clock: Clock;
}) {
  const { db, queue, ai, config, clock } = deps;

  const requireEditableAccount = async (scope: UserScope, accountId: string) => {
    const account = await accountsRepo(db).getEditable(scope, accountId);
    if (account !== undefined) return account;
    if ((await accountsRepo(db).get(scope, accountId)) !== undefined) {
      throw forbidden("Claim this account before reaching out.");
    }
    throw notFound();
  };

  const rep = async (tx: Executor, scope: UserScope) => {
    const user = await usersRepo(tx).findById(scope, scope.userId);
    if (user === undefined) throw notFound();
    return user;
  };

  const footerFor = (user: { name: string; title: string; phone: string | null }, contact: ContactRow) =>
    emailFooter({
      repName: user.name,
      repTitle: user.title,
      repPhone: user.phone,
      companyName: config.COMPANY_NAME,
      postalAddress: config.COMPANY_POSTAL_ADDRESS ?? "(company postal address not set)",
      unsubscribeUrl: unsubscribeUrl(config.PUBLIC_URL, config.UNSUBSCRIBE_SECRET, contact.email ?? ""),
    });

  /** §8.3 checks on the stored text. The AI claims check is kept only while the text it checked is unchanged. */
  const checksFor = async (
    tx: Executor,
    scope: UserScope,
    draft: Pick<DraftRow, "channel" | "subject" | "body" | "accountId">,
    contact: ContactRow,
    claims: CheckResult | undefined,
  ): Promise<CheckResult[]> => {
    // One after another: a transaction's connection runs one query at a time.
    const account = await accountsRepo(tx).get(scope, draft.accountId);
    const suppression = contact.email === null ? null : await suppressionListRepo(tx).reason(scope, contact.email);
    const references = await referencesRepo(tx).allForChecks(scope);
    const results = runChecks({
      channel: draft.channel,
      subject: draft.subject,
      body: draft.body,
      isReply: false,
      contact: {
        email: contact.email,
        emailStatus: contact.emailStatus,
        phone: contact.phone,
        phoneType: contact.phoneType,
        doNotCall: contact.doNotCall,
      },
      account: { doNotContact: account?.account.doNotContact ?? true },
      suppressionReason: suppression,
      companyPostalAddress: config.COMPANY_POSTAL_ADDRESS ?? null,
      references,
      allowlist: mailAllowlist(config),
    });
    return claims === undefined ? results : [...results, claims];
  };

  const storedClaims = (row: DraftRow): CheckResult | undefined =>
    z
      .array(CheckResult)
      .catch([])
      .parse(row.checks)
      .find((check) => check.id === "claims");

  const toDraft = async (tx: Executor, scope: UserScope, row: DraftRow, contact: ContactRow): Promise<Draft> => ({
    id: row.id,
    accountId: row.accountId,
    contactId: row.contactId,
    contact: { name: contactName(contact), email: contact.email, phone: contact.phone },
    dealId: row.dealId,
    channel: row.channel,
    tone: z.enum(["professional", "friendly", "direct"]).catch("professional").parse(row.tone),
    subject: row.subject,
    body: row.body,
    status: row.status,
    checks: z.array(CheckResult).catch([]).parse(row.checks),
    footer: row.channel === "email" ? footerFor(await rep(tx, scope), contact) : null,
    byAi: row.aiCallId !== null,
    updatedAt: row.updatedAt.toISOString(),
  });

  /** outreach_draft, then claim_check on the result (advisory). The model only writes text (rule 5). */
  const write = async (
    scope: UserScope,
    input: { accountId: string; contact: ContactRow; channel: DraftRow["channel"]; tone: CreateDraftRequest["tone"] },
  ) => {
    const now = clock();
    const accountRow = await accountsRepo(db).get(scope, input.accountId);
    if (accountRow === undefined) throw notFound();
    const account = accountRow.account;
    const [signals, reference, deal, user] = await Promise.all([
      signalsRepo(db).listForAccount(scope, input.accountId),
      referencesRepo(db).bestFor(scope, account.propertyType),
      dealsRepo(db).currentForAccount(scope, input.accountId),
      rep(db, scope),
    ]);
    const prompt = outreachDraftPrompt({
      today: isoDay(now),
      channel: input.channel,
      tone: input.tone,
      account: {
        name: account.name,
        propertyType: account.propertyType,
        city: account.city,
        currentProvider: account.currentProvider,
      },
      contact: { firstName: input.contact.firstName, lastName: input.contact.lastName, title: input.contact.title },
      dealStage: deal?.deal.stage ?? null,
      signals: [...signals]
        .sort((a, b) => Number(b.confirmed) - Number(a.confirmed))
        .slice(0, 5)
        .map((signal) => ({ text: signal.text, confirmed: signal.confirmed })),
      reference: reference === undefined ? null : { label: reference.labelAnonymized, stats: reference.stats },
      proposedTimes: [],
      rep: { name: user.name, title: user.title, phone: user.phone },
    });
    const result = await ai.generate({
      feature: "outreach_draft",
      tier: "writer",
      ...prompt,
      schema: OutreachDraftOutput,
      userId: scope.userId,
      check: (output) => draftProblems(output, input.channel),
    });
    const subject = input.channel === "email" ? (result.data.subject ?? "").trim() : null;
    const body = result.data.body.trim();
    const claims = await claimsCheck(scope, input.channel, subject, body);
    return { subject, body, aiCallId: result.aiCallId, claims };
  };

  /** claim_check on a text (advisory: undefined when the AI couldn't answer). */
  const claimsCheck = async (
    scope: UserScope,
    channel: DraftRow["channel"],
    subject: string | null,
    body: string,
  ): Promise<CheckResult | undefined> => {
    let claims: CheckResult | undefined;
    try {
      const flags = (
        await ai.generate({
          feature: "claim_check",
          tier: "fast",
          ...claimCheckPrompt({ subject, body }),
          schema: ClaimCheckOutput,
          userId: scope.userId,
        })
      ).data;
      claims = runChecks({
        channel,
        subject,
        body,
        isReply: false,
        contact: { email: null, emailStatus: "ok", phone: null, phoneType: "unknown", doNotCall: false },
        account: { doNotContact: false },
        suppressionReason: null,
        companyPostalAddress: null,
        references: [],
        claimFlags: flags,
      }).find((check) => check.id === "claims");
    } catch {
      claims = undefined; // advisory only: the draft is still usable without it
    }
    return claims;
  };

  const loadOwn = async (tx: Executor, scope: UserScope, id: string) => {
    const row = await draftsRepo(tx).get(scope, id);
    if (row === undefined) throw notFound();
    return row;
  };

  return {
    async listDrafts(scope: UserScope, accountId: string): Promise<DraftList> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      const [rows, user, sends] = await Promise.all([
        draftsRepo(db).openForAccount(scope, accountId),
        rep(db, scope),
        emailsRepo(db).sendsSince(scope, new Date(clock().getTime() - DAY_MS)),
      ]);
      return {
        items: await Promise.all(rows.map((row) => toDraft(db, scope, row.draft, row.contact))),
        sendsLast24h: sends,
        dailySendCap: user.dailySendCap,
      };
    },

    async createDraft(scope: UserScope, accountId: string, input: CreateDraftRequest): Promise<Draft> {
      await requireEditableAccount(scope, accountId);
      const contact = (await contactsRepo(db).listForAccount(scope, accountId)).find(
        (entry) => entry.id === input.contactId,
      );
      if (contact === undefined) throw notFound("That contact isn't on this account.");
      const written = input.useAi
        ? await write(scope, { accountId, contact, channel: input.channel, tone: input.tone })
        : { subject: input.channel === "email" ? "" : null, body: "", aiCallId: null, claims: undefined };
      const deal = await dealsRepo(db).currentForAccount(scope, accountId);
      return db.transaction(async (tx) => {
        const row = await draftsRepo(tx).insert(scope, {
          accountId,
          contactId: contact.id,
          dealId: deal?.deal.status === "open" ? deal.deal.id : null,
          userId: scope.userId,
          channel: input.channel,
          tone: input.tone,
          subject: written.subject,
          body: written.body,
          aiCallId: written.aiCallId,
        });
        const checks = await checksFor(tx, scope, row, contact, written.claims);
        const updated = (await draftsRepo(tx).update(scope, row.id, { checks })) ?? row;
        return toDraft(tx, scope, updated, contact);
      });
    },

    async getDraft(scope: UserScope, id: string): Promise<Draft> {
      const row = await loadOwn(db, scope, id);
      return toDraft(db, scope, row.draft, row.contact);
    },

    /** Every save re-runs the checks and returns them. */
    async updateDraft(scope: UserScope, id: string, patch: DraftPatch): Promise<Draft> {
      return db.transaction(async (tx) => {
        const row = await draftsRepo(tx).lockForSend(scope, id);
        if (row === undefined) throw notFound();
        if (row.draft.status !== "draft") throw conflict("not_a_draft", "This message was already sent or logged.");
        const next = {
          ...row.draft,
          subject: patch.subject === undefined ? row.draft.subject : patch.subject,
          body: patch.body ?? row.draft.body,
          tone: patch.tone ?? row.draft.tone,
        };
        const textChanged = next.subject !== row.draft.subject || next.body !== row.draft.body;
        const checks = await checksFor(tx, scope, next, row.contact, textChanged ? undefined : storedClaims(row.draft));
        const updated = await draftsRepo(tx).update(scope, id, {
          subject: next.subject,
          body: next.body,
          tone: next.tone,
          checks,
        });
        if (updated === undefined) throw notFound();
        return toDraft(tx, scope, updated, row.contact);
      });
    },

    /** Runs claim_check on the text as it is now (after the rep's edits) and stores the warning with the checks. */
    async checkClaims(scope: UserScope, id: string): Promise<Draft> {
      const row = await loadOwn(db, scope, id);
      if (row.draft.status !== "draft") throw conflict("not_a_draft", "This message was already sent or logged.");
      await ai.assertWithinLimit(scope.userId);
      const claims = await claimsCheck(scope, row.draft.channel, row.draft.subject, row.draft.body);
      if (claims === undefined) throw new HttpError(503, "ai_unavailable", "The wording check didn't run. Try again.");
      return db.transaction(async (tx) => {
        const locked = await draftsRepo(tx).lockForSend(scope, id);
        if (locked?.draft.status !== "draft") throw conflict("not_a_draft", "This message was already sent or logged.");
        // Only if the text is still what was checked.
        const same = locked.draft.subject === row.draft.subject && locked.draft.body === row.draft.body;
        const checks = await checksFor(
          tx,
          scope,
          locked.draft,
          locked.contact,
          same ? claims : storedClaims(locked.draft),
        );
        const updated = await draftsRepo(tx).update(scope, id, { checks });
        if (updated === undefined) throw notFound();
        return toDraft(tx, scope, updated, locked.contact);
      });
    },

    async regenerate(scope: UserScope, id: string): Promise<Draft> {
      const row = await loadOwn(db, scope, id);
      if (row.draft.status !== "draft") throw conflict("not_a_draft", "This message was already sent or logged.");
      const written = await write(scope, {
        accountId: row.draft.accountId,
        contact: row.contact,
        channel: row.draft.channel,
        tone: z.enum(["professional", "friendly", "direct"]).catch("professional").parse(row.draft.tone),
      });
      return db.transaction(async (tx) => {
        const locked = await draftsRepo(tx).lockForSend(scope, id);
        if (locked?.draft.status !== "draft") throw conflict("not_a_draft", "This message was already sent or logged.");
        const next = { ...locked.draft, subject: written.subject, body: written.body };
        const checks = await checksFor(tx, scope, next, locked.contact, written.claims);
        const updated = await draftsRepo(tx).update(scope, id, {
          subject: written.subject,
          body: written.body,
          aiCallId: written.aiCallId,
          checks,
        });
        if (updated === undefined) throw notFound();
        return toDraft(tx, scope, updated, locked.contact);
      });
    },

    /** The single send path (§8.2). One transaction; the message is queued, and the mail.send job sends it. */
    async send(
      scope: UserScope,
      id: string,
      ip: string | null,
    ): Promise<{ messageId: string; status: "queued" | "failed" }> {
      const now = clock();
      const messageId = await db.transaction(async (tx) => {
        // 1. The caller's own draft, locked: a second click waits here and then finds it already sent.
        const row = await draftsRepo(tx).lockForSend(scope, id);
        if (row === undefined) throw notFound();
        const { draft, contact } = row;
        if (draft.channel !== "email")
          throw unprocessable("not_email", "Only email drafts are sent. Log the outcome instead.");
        if (draft.status !== "draft") throw conflict("already_sent", "This email was already sent.");
        const mailbox = await authRepo(tx).mailConnection(scope);
        if (mailbox === undefined || mailbox.needsReconnect) {
          throw conflict("reconnect_mailbox", "Reconnect your mailbox (sign out and sign in again), then send.");
        }

        // 2. Every check again, on the stored text.
        const checks = await checksFor(tx, scope, draft, contact, storedClaims(draft));
        const failures = blockingFailures(checks);
        if (failures.length > 0 || contact.email === null) {
          throw unprocessable("checks_failed", "This email can't be sent until the checks pass.", { checks: failures });
        }

        // 3. The daily cap, counted under a per-user lock so parallel sends can't both slip under it.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`send:${scope.userId}`}))`);
        const user = await rep(tx, scope);
        if ((await emailsRepo(tx).sendsSince(scope, new Date(now.getTime() - DAY_MS))) >= user.dailySendCap) {
          throw tooManySends(user.dailySendCap);
        }

        // 4. The message row (UNIQUE draft_id: a draft is sent once), the draft, activity, audit and the stage.
        const subject = (draft.subject ?? "").trim();
        const message = await emailsRepo(tx).insertQueued(scope, {
          draftId: draft.id,
          userId: scope.userId,
          accountId: draft.accountId,
          dealId: draft.dealId,
          contactId: contact.id,
          direction: "out",
          status: "queued",
          provider: mailbox.provider,
          fromEmail: user.email,
          toEmail: contact.email,
          subject,
          bodyText: `${draft.body.trim()}\n\n${footerFor(user, contact)}`,
        });
        await draftsRepo(tx).update(scope, draft.id, { status: "sent", checks });
        await activitiesRepo(tx).insert(scope, {
          accountId: draft.accountId,
          dealId: draft.dealId,
          contactId: contact.id,
          type: "email_out",
          subject: `Email to ${contactName(contact)}: ${subject}`,
          meta: { emailMessageId: message.id, draftId: draft.id, byAi: draft.aiCallId !== null },
        });
        await auditRepo(tx).write(scope, {
          action: "email.send",
          entityType: "email_message",
          entityId: message.id,
          meta: { draftId: draft.id, accountId: draft.accountId },
          ip,
        });
        await advanceDeal(tx, scope, draft.accountId, "contacted", "email_sent", now);
        return message.id;
      });

      // 5. Queue the send. If queueing fails the message shows as failed with a Retry button.
      try {
        await queue.send(JOBS.mailSend, { messageId });
      } catch {
        await emailsRepo(db).update(scope, messageId, { status: "failed", error: "Could not be queued. Press Retry." });
        return { messageId, status: "failed" };
      }
      return { messageId, status: "queued" };
    },

    /** Call, voicemail and LinkedIn: the rep did it by hand and records the outcome. */
    async log(
      scope: UserScope,
      id: string,
      input: {
        outcome: "connected" | "left_voicemail" | "no_answer" | "wrong_number" | "sent";
        note?: string | undefined;
      },
      ip: string | null,
    ): Promise<Draft> {
      const now = clock();
      return db.transaction(async (tx) => {
        const row = await draftsRepo(tx).lockForSend(scope, id);
        if (row === undefined) throw notFound();
        const { draft, contact } = row;
        if (draft.channel === "email") throw unprocessable("is_email", "Email is sent with Send, not logged.");
        if (draft.status !== "draft") throw conflict("not_a_draft", "This was already logged.");
        const valid =
          draft.channel === "linkedin"
            ? input.outcome === "sent"
            : draft.channel === "voicemail"
              ? input.outcome === "left_voicemail"
              : input.outcome !== "sent";
        if (!valid) throw unprocessable("invalid_outcome", "That outcome doesn't fit this channel.");
        const checks = await checksFor(tx, scope, draft, contact, storedClaims(draft));
        const failures = blockingFailures(checks);
        if (failures.length > 0) {
          throw unprocessable("checks_failed", "This can't be logged until the checks pass.", { checks: failures });
        }
        const updated = await draftsRepo(tx).update(scope, id, { status: "logged", checks });
        if (updated === undefined) throw notFound();
        const label = {
          connected: "connected",
          left_voicemail: "left a voicemail",
          no_answer: "no answer",
          wrong_number: "wrong number",
          sent: "note sent",
        }[input.outcome];
        const channelLabel = { call: "Call", voicemail: "Voicemail", linkedin: "LinkedIn" }[draft.channel];
        await activitiesRepo(tx).insert(scope, {
          accountId: draft.accountId,
          dealId: draft.dealId,
          contactId: contact.id,
          type: draft.channel,
          subject: `${channelLabel} with ${contactName(contact)}: ${label}`,
          body: input.note ?? null,
          meta: { draftId: draft.id, outcome: input.outcome },
        });
        await auditRepo(tx).write(scope, {
          action: "outreach.log",
          entityType: "outreach_draft",
          entityId: draft.id,
          meta: { channel: draft.channel, outcome: input.outcome },
          ip,
        });
        if (input.outcome === "connected" || input.outcome === "left_voicemail" || input.outcome === "sent") {
          await advanceDeal(tx, scope, draft.accountId, "contacted", `${draft.channel}_logged`, now);
        } else {
          await dealsRepo(tx).touch(scope, draft.accountId);
        }
        return toDraft(tx, scope, updated, contact);
      });
    },

    async discard(scope: UserScope, id: string): Promise<void> {
      await db.transaction(async (tx) => {
        const row = await draftsRepo(tx).lockForSend(scope, id);
        if (row === undefined) throw notFound();
        if (row.draft.status !== "draft") throw conflict("not_a_draft", "Only an unsent draft can be discarded.");
        await draftsRepo(tx).update(scope, id, { status: "discarded" });
      });
    },

    async emails(scope: UserScope, accountId: string): Promise<EmailMessage[]> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      return (await emailsRepo(db).listForAccount(scope, accountId)).map((row) => toEmailMessage(row.email));
    },

    /** Re-queues the same message row (§8.2). The checks run again first: the address may have been suppressed. */
    async retry(scope: UserScope, id: string, ip: string | null): Promise<void> {
      await db.transaction(async (tx) => {
        const message = await emailsRepo(tx).lockOwnFailed(scope, id);
        if (message === undefined) throw notFound();
        if (message.status !== "failed") throw conflict("not_failed", "Only a failed email can be retried.");
        const mailbox = await authRepo(tx).mailConnection(scope);
        if (mailbox === undefined || mailbox.needsReconnect) {
          throw conflict("reconnect_mailbox", "Reconnect your mailbox (sign out and sign in again), then retry.");
        }
        const blockers = await messageBlockers(tx, message, config);
        if (blockers.length > 0) {
          throw unprocessable("checks_failed", `This email can't be sent: ${blockers.join("; ")}.`, {
            checks: blockers.map((label) => ({ label })),
          });
        }
        // A retry counts against the daily cap like a new send.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`send:${scope.userId}`}))`);
        const user = await rep(tx, scope);
        if ((await emailsRepo(tx).sendsSince(scope, new Date(clock().getTime() - DAY_MS))) >= user.dailySendCap) {
          throw tooManySends(user.dailySendCap);
        }
        await emailsRepo(tx).update(scope, id, { status: "queued", error: null, sentAt: null });
        await auditRepo(tx).write(scope, { action: "email.retry", entityType: "email_message", entityId: id, ip });
      });
      try {
        await queue.send(JOBS.mailSend, { messageId: id });
      } catch {
        await emailsRepo(db).update(scope, id, { status: "failed", error: "Could not be queued. Press Retry." });
        throw new HttpError(503, "queue_unavailable", "The email couldn't be queued. Try again in a minute.");
      }
    },

    // ───────── suppressions ─────────
    async suppressions(scope: UserScope): Promise<Suppression[]> {
      return (await suppressionListRepo(db).list(scope)).map((row) => ({
        email: row.email,
        reason: row.reason,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async addSuppression(scope: UserScope, input: { email: string; note?: string | undefined }, ip: string | null) {
      await db.transaction(async (tx) => {
        const added = await suppressionListRepo(tx).add(scope, {
          email: input.email,
          reason: "manual",
          note: input.note ?? null,
          createdBy: scope.userId,
        });
        if (!added) throw conflict("already_suppressed", "That address is already on the list.");
        await auditRepo(tx).write(scope, {
          action: "suppression.add",
          entityType: "suppression",
          meta: { reason: "manual", email: input.email.toLowerCase() },
          ip,
        });
      });
    },

    async removeSuppression(scope: UserScope, email: string, ip: string | null) {
      await db.transaction(async (tx) => {
        if (!(await suppressionListRepo(tx).remove(scope, email))) throw notFound();
        await auditRepo(tx).write(scope, {
          action: "suppression.remove",
          entityType: "suppression",
          meta: { email: email.toLowerCase() },
          ip,
        });
      });
    },
  };
}

export type OutreachService = ReturnType<typeof createOutreachService>;

/** Unsubscribe by link (§8.4). Public: the token is the only credential. Idempotent. */
export function createUnsubscribeService(deps: { db: Database; secret: string }) {
  return {
    read: (token: string) => readUnsubscribeToken(deps.secret, token),

    async confirm(token: string): Promise<boolean> {
      const email = readUnsubscribeToken(deps.secret, token);
      if (email === undefined) return false;
      await unsubscribeAddress(deps.db, email, "Unsubscribed using the link in an email");
      return true;
    },
  };
}

/** Suppresses the address company-wide and marks every contact with it unsubscribed, with timeline and audit rows. */
export async function unsubscribeAddress(db: Database, email: string, reasonText: string): Promise<void> {
  await db.transaction((tx) => unsubscribeAddressIn(tx, email, reasonText));
}

/** The same, inside the caller's transaction. */
export async function unsubscribeAddressIn(tx: Executor, email: string, reasonText: string): Promise<void> {
  const scope = systemScope("unsubscribe");
  {
    const added = await suppressionListRepo(tx).add(scope, { email, reason: "unsubscribe", createdBy: null });
    const contacts = await contactEmailRepo(tx).markByEmail(scope, email, "unsubscribed");
    if (!added) return;
    for (const accountId of new Set(contacts.map((contact) => contact.accountId))) {
      await activitiesRepo(tx).insert(scope, {
        accountId,
        type: "note",
        subject: `${reasonText}. No more email will be sent to ${email}.`,
        meta: { suppression: "unsubscribe" },
      });
    }
    await auditRepo(tx).write(scope, {
      action: "suppression.add",
      entityType: "suppression",
      meta: { reason: "unsubscribe", email: email.toLowerCase() },
    });
  }
}

/** What stops an already-written message going out now (Retry and the mail.send job re-check, §8.2 and rule 7):
    the recipient checks and the named-client check on its stored subject and body. Empty when it may go. */
export async function messageBlockers(
  tx: Executor,
  message: Pick<EmailRow, "contactId" | "accountId" | "toEmail" | "subject" | "bodyText">,
  config: Pick<Env, "MAIL_ALLOWLIST">,
): Promise<string[]> {
  const scope = systemScope("send check");
  if (message.contactId === null) return ["The contact was removed."];
  const contact = await contactEmailRepo(tx).get(scope, message.contactId);
  if (contact === undefined) return ["The contact was removed."];
  if (contact.email?.toLowerCase() !== message.toEmail.toLowerCase()) return ["The contact's email address changed."];
  const account = await accountsRepo(tx).get(scope, message.accountId);
  const suppression = await suppressionListRepo(tx).reason(scope, message.toEmail);
  const references = await referencesRepo(tx).allForChecks(scope);
  const results = runChecks({
    channel: "email",
    subject: message.subject,
    body: message.bodyText,
    isReply: false,
    contact: {
      email: contact.email,
      emailStatus: contact.emailStatus,
      phone: null,
      phoneType: "unknown",
      doNotCall: false,
    },
    account: { doNotContact: account === undefined || account.account.doNotContact },
    suppressionReason: suppression,
    companyPostalAddress: "checked when written",
    references,
    allowlist: mailAllowlist(config),
  });
  return blockingFailures(results)
    .filter((check) => check.id === "recipient_ok" || check.id === "no_named_client")
    .map((check) => check.label);
}
