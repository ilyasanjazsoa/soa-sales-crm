import type { Database, Executor } from "@soa/db";
import { ReplyClassifyOutput, type Env, type ReplyClass } from "@soa/shared";
import type { TokenCipher } from "../auth/crypto";
import type { Clock } from "../clock";
import type { AiClient } from "../providers/ai/client";
import { replyClassifyPrompt } from "../providers/ai/prompts";
import {
  MailAuthError,
  MailCursorExpired,
  MailPermanentError,
  MailRetryableError,
  type InboundMail,
  type MailProvider,
} from "../providers/mail/types";
import { auditRepo } from "../repos/audit";
import { activitiesRepo, tasksRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import { contactEmailRepo, emailsRepo, mailAccountsRepo, suppressionListRepo, type EmailRow } from "../repos/outreach";
import { systemScope } from "../repos/scope";
import { accessTokenFor } from "./oauth-tokens";
import { messageBlockers, unsubscribeAddressIn } from "./outreach";
import { unsubscribeUrl } from "./unsubscribe";

/* The mail jobs (ARCHITECTURE.md §8.2, §8.4, §14). runMailSend is the only caller of MailProvider.send
   (CLAUDE.md rule 2), and it only sends a `queued` row that the send route created.

   At most once: the row is claimed (sent_at set while still queued) in a short committed transaction before the
   provider is called, and the call happens outside any transaction. Only errors that prove nothing was sent
   (MailRetryableError) release the claim for an automatic retry. Anything else marks the message failed with a
   note to check Sent Items, and the rep decides whether to press Retry. */

export interface MailJobDeps {
  db: Database;
  mail: MailProvider;
  cipher: TokenCipher;
  ai: AiClient;
  clock: Clock;
  config: Pick<Env, "MAIL_ALLOWLIST" | "PUBLIC_URL" | "UNSUBSCRIBE_SECRET">;
}

const RECONNECT = "Reconnect your mailbox (sign out and sign in again), then press Retry.";
const UNKNOWN = "Microsoft 365 didn't confirm the send. Check your Sent Items before pressing Retry.";
const GAVE_UP = "the mail server could not be reached after several tries. Press Retry.";

/** Marks a message failed and says so on the timeline. */
async function failMessage(tx: Executor, message: EmailRow, error: string): Promise<void> {
  const scope = systemScope("mail.send");
  await emailsRepo(tx).update(scope, message.id, { status: "failed", error, sentAt: null });
  await activitiesRepo(tx).insert(scope, {
    accountId: message.accountId,
    dealId: message.dealId,
    contactId: message.contactId,
    type: "email_out",
    subject: `Email not sent: ${error}`,
    meta: { emailMessageId: message.id, failed: true },
  });
}

/** mail.send: sends one queued message. */
export async function runMailSend(
  deps: MailJobDeps,
  job: { messageId: string },
  options: { finalAttempt: boolean },
): Promise<void> {
  const scope = systemScope("mail.send");
  const { db } = deps;

  // 1. Claim the row and re-check it, committed before anything leaves the building.
  const claimed = await db.transaction(async (tx) => {
    const message = await emailsRepo(tx).lockQueued(scope, job.messageId);
    if (message === undefined) return undefined; // not a queued, unclaimed CRM message
    const blockers = await messageBlockers(tx, message, deps.config);
    if (blockers.length > 0) {
      await failMessage(tx, message, `${blockers.join("; ")}.`);
      return undefined;
    }
    await emailsRepo(tx).update(scope, message.id, { sentAt: deps.clock() });
    return message;
  });
  if (claimed === undefined) return;
  const message = claimed;

  const release = async (error: unknown) => {
    // Nothing was sent: free the claim so the next attempt can run, or give up on the last one.
    if (options.finalAttempt) {
      await db.transaction((tx) => failMessage(tx, message, GAVE_UP));
      return;
    }
    await emailsRepo(db).update(scope, message.id, { sentAt: null });
    throw error;
  };

  // 2. A token. A refresh the provider refuses needs the rep; a network problem is retried.
  let token;
  try {
    token = await accessTokenFor({ ...deps, refresher: deps.mail }, message.userId);
  } catch (error) {
    await release(error);
    return;
  }
  if (token === "reconnect") {
    await db.transaction((tx) => failMessage(tx, message, RECONNECT));
    return;
  }

  // 3. Send, outside any transaction.
  const sender = await mailAccountsRepo(db).get(scope, message.userId);
  const link = unsubscribeUrl(deps.config.PUBLIC_URL, deps.config.UNSUBSCRIBE_SECRET, message.toEmail);
  let sent;
  try {
    sent = await deps.mail.send(token.accessToken, {
      from: { email: message.fromEmail, name: sender?.user.name ?? message.fromEmail },
      to: message.toEmail,
      subject: message.subject,
      text: message.bodyText,
      headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  } catch (error) {
    if (error instanceof MailRetryableError) {
      await release(error);
      return;
    }
    if (error instanceof MailAuthError) {
      await mailAccountsRepo(db).update(scope, message.userId, token.provider, { needsReconnect: true });
      await db.transaction((tx) => failMessage(tx, message, RECONNECT));
      return;
    }
    const reason = error instanceof MailPermanentError ? `${error.message}.` : UNKNOWN;
    await db.transaction((tx) => failMessage(tx, message, reason));
    return;
  }

  // 4. Record it.
  await emailsRepo(db).update(scope, message.id, {
    status: "sent",
    providerMessageId: sent.providerMessageId,
    providerThreadId: sent.providerThreadId,
    sentAt: deps.clock(),
    error: null,
  });
}

/** Fails queued messages a worker never finished, so none waits forever and Retry is offered (§8.2). */
export async function sweepStuckMail(db: Database, now: Date): Promise<number> {
  const scope = systemScope("mail sweep");
  const stuck = await emailsRepo(db).stuck(
    scope,
    new Date(now.getTime() - 15 * 60_000),
    new Date(now.getTime() - 3 * 60 * 60_000),
  );
  for (const entry of stuck) {
    await db.transaction(async (tx) => {
      const message = await emailsRepo(tx).get(scope, entry.id);
      if (message?.status !== "queued") return;
      await failMessage(tx, message, entry.claimed ? UNKNOWN : "it was never picked up for sending. Press Retry.");
    });
  }
  return stuck.length;
}

// ───────── mail.sync ─────────

/** Asking to stop, in plain words. Acted on by code even if the AI is down (rule 7). */
const ASKS_TO_STOP =
  /\b(unsubscribe|remove me|take me off|stop (emailing|e-?mailing|sending|contacting)|do not (email|contact) me|don'?t (email|contact) me)\b/i;

async function classify(deps: MailJobDeps, userId: string, reply: { subject: string; text: string }) {
  try {
    return (
      await deps.ai.generate({
        feature: "reply_classify",
        tier: "fast",
        ...replyClassifyPrompt(reply),
        schema: ReplyClassifyOutput,
        userId,
      })
    ).data;
  } catch {
    return null; // stored unclassified; the next sync tries again
  }
}

/** What code does with a classified reply: the task for "interested", the suppression for "unsubscribe". */
async function actOn(
  tx: Executor,
  deps: MailJobDeps,
  thread: EmailRow,
  userId: string,
  classification: ReplyClass | null,
  asksToStop: boolean,
): Promise<void> {
  const scope = systemScope("mail.sync");
  if (classification === "interested") {
    const name = (await contactEmailRepo(tx).name(scope, thread.contactId)) ?? thread.toEmail;
    await tasksRepo(tx).insert(scope, {
      ownerUserId: userId,
      accountId: thread.accountId,
      dealId: thread.dealId,
      title: `Reply to ${name}`,
      dueAt: deps.clock(),
    });
  }
  if (classification === "unsubscribe" || asksToStop) {
    await unsubscribeAddressIn(tx, thread.toEmail, `${thread.toEmail} replied asking to unsubscribe`);
  }
}

async function storeBounce(
  deps: MailJobDeps,
  thread: EmailRow,
  inbound: InboundMail,
  userId: string,
  provider: "microsoft" | "google",
): Promise<boolean> {
  const scope = systemScope("mail.sync");
  return deps.db.transaction(async (tx) => {
    // The notice is stored once (UNIQUE provider message id), so a repeated sync can't process it twice.
    const notice = await emailsRepo(tx).insertInbound(scope, {
      userId,
      accountId: thread.accountId,
      dealId: thread.dealId,
      contactId: thread.contactId,
      direction: "in",
      status: "bounced",
      provider,
      providerMessageId: inbound.providerMessageId,
      providerThreadId: inbound.providerThreadId,
      fromEmail: inbound.fromEmail,
      toEmail: inbound.toEmail,
      subject: inbound.subject.slice(0, 500),
      bodyText: "",
      receivedAt: inbound.receivedAt,
    });
    if (notice === undefined) return false;
    await emailsRepo(tx).update(scope, thread.id, { status: "bounced", error: "Delivery failed (bounce)." });
    const added = await suppressionListRepo(tx).add(scope, {
      email: thread.toEmail,
      reason: "bounce",
      createdBy: null,
    });
    await contactEmailRepo(tx).markByEmail(scope, thread.toEmail, "bounced");
    await activitiesRepo(tx).insert(scope, {
      accountId: thread.accountId,
      dealId: thread.dealId,
      contactId: thread.contactId,
      type: "email_in",
      subject: `Email to ${thread.toEmail} bounced. The address is now suppressed.`,
      meta: { emailMessageId: thread.id, bounce: true },
    });
    if (added) {
      await auditRepo(tx).write(scope, {
        action: "suppression.add",
        entityType: "suppression",
        meta: { reason: "bounce", email: thread.toEmail.toLowerCase() },
      });
    }
    return true;
  });
}

/** mail.sync: replies and bounces on CRM threads only. Any other mail is skipped and never stored or sent to AI. */
export async function runMailSync(deps: MailJobDeps, job: { userId: string }): Promise<{ stored: number }> {
  const scope = systemScope("mail.sync");
  const token = await accessTokenFor({ ...deps, refresher: deps.mail }, job.userId);
  if (token === "reconnect") return { stored: 0 };
  const row = await mailAccountsRepo(deps.db).get(scope, job.userId);
  if (row === undefined) return { stored: 0 };
  let listed;
  try {
    listed = await deps.mail.listNew(token.accessToken, row.account.mailSyncCursor);
  } catch (error) {
    if (error instanceof MailCursorExpired) {
      await mailAccountsRepo(deps.db).update(scope, job.userId, token.provider, { mailSyncCursor: null });
      return { stored: 0 };
    }
    if (!(error instanceof MailAuthError)) throw error;
    await mailAccountsRepo(deps.db).update(scope, job.userId, token.provider, { needsReconnect: true });
    return { stored: 0 };
  }

  let stored = 0;
  for (const inbound of listed.messages) {
    if (inbound.fromEmail.toLowerCase() === row.user.email.toLowerCase()) continue; // the rep's own copies
    const thread = await emailsRepo(deps.db).outboundOnThread(
      scope,
      token.provider,
      inbound.providerThreadId,
      job.userId,
    );
    if (thread === undefined) continue; // not a CRM thread: never stored, never sent to the AI

    if (inbound.bounce) {
      if (await storeBounce(deps, thread, inbound, job.userId, token.provider)) stored += 1;
      continue;
    }

    // Classify first (outside the transaction), then store the reply, its activity and what follows, together.
    const classified = await classify(deps, job.userId, inbound);
    const asksToStop = ASKS_TO_STOP.test(`${inbound.subject}\n${inbound.text}`);
    const saved = await deps.db.transaction(async (tx) => {
      const message = await emailsRepo(tx).insertInbound(scope, {
        userId: job.userId,
        accountId: thread.accountId,
        dealId: thread.dealId,
        contactId: thread.contactId,
        direction: "in",
        status: "received",
        provider: token.provider,
        providerMessageId: inbound.providerMessageId,
        providerThreadId: inbound.providerThreadId,
        fromEmail: inbound.fromEmail,
        toEmail: inbound.toEmail || row.user.email,
        subject: inbound.subject.slice(0, 500),
        bodyText: inbound.text.slice(0, 50_000),
        aiClassification: classified?.classification ?? null,
        receivedAt: inbound.receivedAt,
      });
      if (message === undefined) return false; // already stored on an earlier sync
      await activitiesRepo(tx).insert(scope, {
        accountId: thread.accountId,
        dealId: thread.dealId,
        contactId: thread.contactId,
        type: "email_in",
        subject: `Reply from ${inbound.fromEmail}: ${inbound.subject.slice(0, 200)}`,
        body: classified?.summary ?? null,
        meta: { emailMessageId: message.id, classification: classified?.classification ?? null },
      });
      await dealsRepo(tx).touch(scope, thread.accountId);
      await actOn(tx, deps, thread, job.userId, classified?.classification ?? null, asksToStop);
      return true;
    });
    if (saved) stored += 1;
  }

  // Replies the AI couldn't classify before: try again, and act on the result.
  const since = new Date(deps.clock().getTime() - 3 * 86_400_000);
  for (const reply of await emailsRepo(deps.db).unclassified(scope, job.userId, since)) {
    const classified = await classify(deps, job.userId, { subject: reply.subject, text: reply.bodyText });
    if (classified === null) continue;
    await deps.db.transaction(async (tx) => {
      const thread =
        reply.providerThreadId === null
          ? undefined
          : await emailsRepo(tx).outboundOnThread(scope, reply.provider, reply.providerThreadId, job.userId);
      await emailsRepo(tx).update(scope, reply.id, { aiClassification: classified.classification });
      await activitiesRepo(tx).insert(scope, {
        accountId: reply.accountId,
        dealId: reply.dealId,
        contactId: reply.contactId,
        type: "email_in",
        subject: `Reply from ${reply.fromEmail} read as: ${classified.classification.replace(/_/g, " ")}`,
        body: classified.summary,
        meta: { emailMessageId: reply.id, classification: classified.classification },
      });
      // A plain-words unsubscribe was already acted on when the reply was stored.
      if (thread !== undefined) await actOn(tx, deps, thread, job.userId, classified.classification, false);
    });
  }

  await mailAccountsRepo(deps.db).update(scope, job.userId, token.provider, { mailSyncCursor: listed.cursor });
  return { stored };
}

/** The 2-minute tick: one mail.sync per connected user (pg-boss keeps one per user at a time). */
export async function syncableUsers(db: Database): Promise<string[]> {
  return mailAccountsRepo(db).syncable(systemScope("mail.sync tick"));
}
