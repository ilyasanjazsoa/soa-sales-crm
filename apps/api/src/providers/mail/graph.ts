import { z } from "zod";
import type { Clock } from "../../clock";
import { createMicrosoftTokenRefresher } from "../identity/refresh";
import {
  looksLikeBounce,
  MailAuthError,
  MailCursorExpired,
  MailPermanentError,
  MailRetryableError,
  type InboundMail,
  type MailProvider,
  type OutgoingMail,
} from "./types";

/* Microsoft Graph (DECISIONS.md decision 10).
   Sending: the message is created in the rep's mailbox from MIME (so standard headers such as List-Unsubscribe are
   kept; Graph's JSON form only allows X- headers), then sent. Creating it tells us the conversation id (the thread).
   If the create step fails, nothing was sent and the job may retry. If /send fails with a 5xx or times out, delivery
   is unknown: the error is not retryable, so the rep decides (no second copy by accident).
   Reading: an Inbox delta query. The first run only finds the starting point; older mail is never read. The caller
   keeps only messages on CRM threads (§8.4). */

const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 30_000;
const INIT = "init:"; // a cursor that is still walking to the starting point (nothing collected)

const Created = z.object({ id: z.string(), conversationId: z.string(), internetMessageId: z.string().optional() });
const DeltaMessage = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  internetMessageId: z.string().optional(),
  subject: z.string().nullable().optional(),
  receivedDateTime: z.string().optional(),
  from: z.object({ emailAddress: z.object({ address: z.string() }) }).optional(),
  toRecipients: z.array(z.object({ emailAddress: z.object({ address: z.string() }) })).optional(),
  body: z.object({ content: z.string() }).optional(),
  "@removed": z.unknown().optional(),
});
const DeltaPage = z.object({
  value: z.array(DeltaMessage),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

/** RFC 2047 encoded-word for a header value that isn't plain ASCII. */
const headerValue = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
const noBreaks = (value: string) => value.replace(/[\r\n]+/g, " ");

/** A text/plain MIME message, base64 as Graph expects. From is set by Graph to the signed-in mailbox. */
export function toMime(mail: OutgoingMail): string {
  const body = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const lines = [
    `To: ${noBreaks(mail.to)}`,
    `Subject: ${headerValue(noBreaks(mail.subject))}`,
    ...Object.entries(mail.headers).map(([name, value]) => `${name}: ${noBreaks(value)}`),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64");
}

export interface GraphOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  clock: Clock;
  fetch?: typeof fetch;
}

export function createGraphMailProvider(options: GraphOptions): MailProvider {
  const http = options.fetch ?? fetch;
  const tokens = createMicrosoftTokenRefresher(options);

  const request = (accessToken: string, url: string, init: RequestInit & { contentType?: string } = {}) =>
    http(url.startsWith("https://") ? url : `${GRAPH}${url}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": init.contentType ?? "application/json",
        prefer: 'outlook.body-content-type="text"',
      },
    });

  const deleteDraft = (accessToken: string, id: string) =>
    request(accessToken, `/me/messages/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);

  return {
    provider: "microsoft",

    async send(accessToken, mail) {
      // Step 1: create. Any failure here means nothing was sent.
      let created: z.infer<typeof Created>;
      try {
        const response = await request(accessToken, "/me/messages", {
          method: "POST",
          contentType: "text/plain",
          body: toMime(mail),
        });
        if (response.status === 401 || response.status === 403) throw new MailAuthError();
        if (response.status === 400 || response.status === 413) {
          throw new MailPermanentError(`Microsoft 365 refused the message (${String(response.status)})`);
        }
        if (!response.ok) throw new MailRetryableError(`Microsoft Graph error ${String(response.status)}`);
        created = Created.parse(await response.json());
      } catch (error) {
        if (
          error instanceof MailAuthError ||
          error instanceof MailPermanentError ||
          error instanceof MailRetryableError
        ) {
          throw error;
        }
        throw new MailRetryableError("Microsoft 365 could not be reached");
      }

      // Step 2: send. A clear refusal means not sent; a 5xx or timeout means delivery is unknown.
      let response: Response;
      try {
        response = await request(accessToken, `/me/messages/${encodeURIComponent(created.id)}/send`, {
          method: "POST",
        });
      } catch {
        throw new Error("Microsoft 365 did not confirm the send");
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 400) {
          await deleteDraft(accessToken, created.id);
          if (response.status === 401 || response.status === 403) throw new MailAuthError();
          if (response.status === 400) throw new MailPermanentError("Microsoft 365 refused the message (400)");
          throw new MailRetryableError("Microsoft 365 is busy (429)");
        }
        throw new Error(`Microsoft 365 did not confirm the send (${String(response.status)})`);
      }
      return { providerMessageId: created.internetMessageId ?? created.id, providerThreadId: created.conversationId };
    },

    async listNew(accessToken, cursor) {
      const select = "id,conversationId,internetMessageId,subject,receivedDateTime,from,toRecipients,body";
      const collect = cursor !== null && !cursor.startsWith(INIT);
      let url = cursor === null ? `/me/mailFolders/inbox/messages/delta?$select=${select}` : cursor.replace(INIT, "");
      const messages: InboundMail[] = [];
      for (let page = 0; page < 50; page += 1) {
        const response = await request(accessToken, url);
        if (response.status === 401 || response.status === 403) throw new MailAuthError();
        if (response.status === 410) throw new MailCursorExpired();
        if (response.status === 400) {
          const text = await response.text();
          if (/syncStateNotFound|resyncRequired|invalid.*delta/i.test(text)) throw new MailCursorExpired();
          throw new Error("Microsoft Graph error 400");
        }
        if (!response.ok) throw new Error(`Microsoft Graph error ${String(response.status)}`);
        const data = DeltaPage.parse(await response.json());
        if (collect) {
          for (const message of data.value) {
            if (message["@removed"] !== undefined || message.conversationId === undefined) continue;
            const from = message.from?.emailAddress.address ?? "";
            const subject = message.subject ?? "";
            messages.push({
              providerMessageId: message.internetMessageId ?? message.id,
              providerThreadId: message.conversationId,
              fromEmail: from.toLowerCase(),
              toEmail: message.toRecipients?.[0]?.emailAddress.address.toLowerCase() ?? "",
              subject,
              text: message.body?.content ?? "",
              receivedAt: new Date(message.receivedDateTime ?? options.clock().toISOString()),
              bounce: looksLikeBounce(from, subject),
            });
          }
        }
        if (data["@odata.deltaLink"] !== undefined) return { messages, cursor: data["@odata.deltaLink"] };
        if (data["@odata.nextLink"] === undefined) break;
        url = data["@odata.nextLink"];
      }
      // Not at the end yet: carry on next time from here, still without collecting if this was the first walk.
      return { messages, cursor: collect ? url : `${INIT}${url}` };
    },

    refresh: (refreshToken) => tokens.refresh(refreshToken),
  };
}
