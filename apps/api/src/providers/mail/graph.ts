import { z } from "zod";
import type { Clock } from "../../clock";
import { createMicrosoftTokenRefresher } from "../identity/refresh";
import { looksLikeBounce, MailAuthError, MailPermanentError, type InboundMail, type MailProvider } from "./types";

/* Microsoft Graph (DECISIONS.md decision 10). A message is created in the rep's mailbox and then sent, so the CRM
   learns its id and conversation id (the thread). Replies and delivery failures are read with an Inbox delta query;
   the caller keeps only messages whose conversation id belongs to a CRM thread (§8.4). */

const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 30_000;

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

  const call = async (accessToken: string, url: string, init: RequestInit = {}) => {
    const response = await http(url.startsWith("https://") ? url : `${GRAPH}${url}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        prefer: 'outlook.body-content-type="text"',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (response.status === 401) throw new MailAuthError();
    // 400/403/404/413 cannot succeed on retry; 429 and 5xx are retried by the job.
    if ([400, 403, 404, 413].includes(response.status)) {
      throw new MailPermanentError(`Microsoft Graph refused the request (${String(response.status)})`);
    }
    if (!response.ok) throw new Error(`Microsoft Graph error ${String(response.status)}`);
    return response;
  };

  return {
    provider: "microsoft",

    async send(accessToken, mail) {
      const created = Created.parse(
        await (
          await call(accessToken, "/me/messages", {
            method: "POST",
            body: JSON.stringify({
              subject: mail.subject,
              body: { contentType: "Text", content: mail.text },
              toRecipients: [{ emailAddress: { address: mail.to } }],
              internetMessageHeaders: Object.entries(mail.headers).map(([name, value]) => ({
                name: name.startsWith("X-") || name.startsWith("x-") ? name : `X-${name}`,
                value,
              })),
            }),
          })
        ).json(),
      );
      await call(accessToken, `/me/messages/${encodeURIComponent(created.id)}/send`, { method: "POST" });
      return { providerMessageId: created.internetMessageId ?? created.id, providerThreadId: created.conversationId };
    },

    async listNew(accessToken, cursor) {
      const select = "id,conversationId,internetMessageId,subject,receivedDateTime,from,toRecipients,body";
      let url = cursor ?? `/me/mailFolders/inbox/messages/delta?$select=${select}`;
      const messages: InboundMail[] = [];
      // The first run (no cursor) only establishes the starting point: older mail is never read.
      const collect = cursor !== null;
      for (let page = 0; page < 20; page += 1) {
        const data = DeltaPage.parse(await (await call(accessToken, url)).json());
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
      return { messages, cursor: url };
    },

    refresh: (refreshToken) => tokens.refresh(refreshToken),
  };
}
