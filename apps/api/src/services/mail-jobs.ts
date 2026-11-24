import type { Database } from "@soa/db";
import { ReplyClassifyOutput, type Env, type ReplyClassifyOutput as ReplyClassification } from "@soa/shared";
import type { TokenCipher } from "../auth/crypto";
import type { Clock } from "../clock";
import type { AiClient } from "../providers/ai/client";
import { replyClassifyPrompt } from "../providers/ai/prompts";
import { MailAuthError, MailPermanentError, type MailProvider } from "../providers/mail/types";
import { auditRepo } from "../repos/audit";
import { activitiesRepo, tasksRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import { contactEmailRepo, emailsRepo, mailAccountsRepo, suppressionListRepo } from "../repos/outreach";
import { systemScope } from "../repos/scope";
import { mailAllowlist, unsubscribeAddress } from "./outreach";
import { unsubscribeUrl } from "./unsubscribe";

/* The mail jobs (ARCHITECTURE.md §8.2, §8.4, §14). runMailSend is the only caller of MailProvider.send
   (CLAUDE.md rule 2), and it only sends a `queued` row that the send route created. */

export interface MailJobDeps {
  db: Database;
  mail: MailProvider;
  cipher: TokenCipher;
  ai: AiClient;
  clock: Clock;
  config: Pick<Env, "MAIL_ALLOWLIST" | "PUBLIC_URL" | "UNSUBSCRIBE_SECRET">;
}

const RECONNECT = "Reconnect your mailbox (sign out and sign in again), then press Retry.";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A usable access token for the user, refreshed when close to expiry. "reconnect" when the rep must sign in again:
    needs_reconnect is set and nothing retries until they do (§8.4). */
export async function accessTokenFor(
  deps: Pick<MailJobDeps, "db" | "mail" | "cipher" | "clock">,
  userId: string,
): Promise<{ accessToken: string; provider: "microsoft" | "google" } | "reconnect"> {
  const scope = systemScope("mail token");
  const repo = mailAccountsRepo(deps.db);
  const row = await repo.get(scope, userId);
  if (row === undefined || row.account.needsReconnect || !row.user.active) return "reconnect";
  const { account } = row;
  if (account.expiresAt.getTime() - deps.clock().getTime() > REFRESH_MARGIN_MS) {
    return { accessToken: deps.cipher.decrypt(account.accessTokenEnc), provider: account.provider };
  }
  try {
    const tokens = await deps.mail.refresh(deps.cipher.decrypt(account.refreshTokenEnc));
    await repo.update(scope, userId, account.provider, {
      accessTokenEnc: deps.cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: deps.cipher.encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
    });
    return { accessToken: tokens.accessToken, provider: account.provider };
  } catch (error) {
    if (!(error instanceof MailAuthError)) throw error; // network trouble: try again later
    await repo.update(scope, userId, account.provider, { needsReconnect: true });
    return "reconnect";
  }
}

/** mail.send: sends one queued message. Permanent problems fail it at once; others are retried (3, exponential). */
export async function runMailSend(
  deps: MailJobDeps,
  job: { messageId: string },
  options: { finalAttempt: boolean },
): Promise<void> {
  const scope = systemScope("mail.send");
  await deps.db.transaction(async (tx) => {
    // Locks the row while sending, so a duplicate job can't send it twice.
    const message = await emailsRepo(tx).lockQueued(scope, job.messageId);
    if (message === undefined) return; // not a queued CRM message (already sent, failed or never created by the route)

    const fail = async (error: string) => {
      await emailsRepo(tx).update(scope, message.id, { status: "failed", error });
      await activitiesRepo(tx).insert(scope, {
        accountId: message.accountId,
        dealId: message.dealId,
        contactId: message.contactId,
        type: "email_out",
        subject: `Email not sent: ${error}`,
        meta: { emailMessageId: message.id, failed: true },
      });
    };

    // Last line of defence: the address may have been suppressed since the click (rule 7).
    if ((await suppressionListRepo(tx).reason(scope, message.toEmail)) !== null) {
      await fail("the address is on the suppression list.");
      return;
    }
    const allowlist = mailAllowlist(deps.config);
    if (allowlist !== null && !allowlist.includes(message.toEmail.toLowerCase())) {
      await fail("staging only sends to addresses on MAIL_ALLOWLIST.");
      return;
    }

    const token = await accessTokenFor(deps, message.userId);
    if (token === "reconnect") {
      await fail(RECONNECT);
      return;
    }
    const sender = await mailAccountsRepo(tx).get(scope, message.userId);
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
      if (error instanceof MailAuthError) {
        await mailAccountsRepo(deps.db).update(scope, message.userId, token.provider, { needsReconnect: true });
        await fail(RECONNECT);
        return;
      }
      if (error instanceof MailPermanentError) {
        await fail(`${error.message}.`);
        return;
      }
      if (options.finalAttempt) {
        await fail("the mail server could not be reached after several tries. Press Retry.");
        return;
      }
      throw error; // retried by pg-boss
    }
    await emailsRepo(tx).update(scope, message.id, {
      status: "sent",
      providerMessageId: sent.providerMessageId,
      providerThreadId: sent.providerThreadId,
      sentAt: deps.clock(),
      error: null,
    });
  });
}

/** mail.sync: replies and bounces on CRM threads only. Any other mail is skipped and never stored or sent to AI. */
export async function runMailSync(deps: MailJobDeps, job: { userId: string }): Promise<{ stored: number }> {
  const scope = systemScope("mail.sync");
  const token = await accessTokenFor(deps, job.userId);
  if (token === "reconnect") return { stored: 0 };
  const row = await mailAccountsRepo(deps.db).get(scope, job.userId);
  if (row === undefined) return { stored: 0 };
  let listed;
  try {
    listed = await deps.mail.listNew(token.accessToken, row.account.mailSyncCursor);
  } catch (error) {
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
    if (thread === undefined) continue; // not a CRM thread: never stored

    if (inbound.bounce) {
      await deps.db.transaction(async (tx) => {
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
            meta: { reason: "bounce" },
          });
        }
      });
      stored += 1;
      continue;
    }

    const message = await emailsRepo(deps.db).insertInbound(scope, {
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
      receivedAt: inbound.receivedAt,
    });
    if (message === undefined) continue; // already stored on an earlier sync
    stored += 1;

    // The reply is untrusted text: the model only labels it; code decides what happens (rules 4 and 5).
    let classified: ReplyClassification | null = null;
    try {
      classified = (
        await deps.ai.generate({
          feature: "reply_classify",
          tier: "fast",
          ...replyClassifyPrompt({ subject: inbound.subject, text: inbound.text }),
          schema: ReplyClassifyOutput,
          userId: job.userId,
        })
      ).data;
    } catch {
      classified = null; // stored and shown unclassified
    }

    const name = (await contactEmailRepo(deps.db).name(scope, thread.contactId)) ?? inbound.fromEmail;
    await deps.db.transaction(async (tx) => {
      if (classified !== null) {
        await emailsRepo(tx).update(scope, message.id, { aiClassification: classified.classification });
      }
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
      if (classified?.classification === "interested") {
        await tasksRepo(tx).insert(scope, {
          ownerUserId: job.userId,
          accountId: thread.accountId,
          dealId: thread.dealId,
          title: `Reply to ${name}`,
          dueAt: deps.clock(),
        });
      }
    });
    if (classified?.classification === "unsubscribe") {
      await unsubscribeAddress(deps.db, thread.toEmail, `${thread.toEmail} replied asking to unsubscribe`);
    }
  }
  await mailAccountsRepo(deps.db).update(scope, job.userId, token.provider, { mailSyncCursor: listed.cursor });
  return { stored };
}

/** The 2-minute tick: one mail.sync per connected user (pg-boss keeps one per user at a time). */
export async function syncableUsers(db: Database): Promise<string[]> {
  return mailAccountsRepo(db).syncable(systemScope("mail.sync tick"));
}
