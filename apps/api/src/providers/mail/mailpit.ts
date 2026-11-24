import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { createFakeTokenRefresher } from "../identity/refresh";
import { looksLikeBounce, MailPermanentError, MailRetryableError, type InboundMail, type MailProvider } from "./types";

/* FAKE_PROVIDERS mail: delivers over SMTP to Mailpit (docker compose) and reads replies back through Mailpit's API.
   Nothing leaves the machine. A reply is simulated by sending a message to the rep that has In-Reply-To set. */

const MessageSummary = z.object({ ID: z.string(), Created: z.string() });
const SearchResult = z.object({ messages: z.array(MessageSummary) });
const Address = z.object({ Address: z.string() });
const Message = z.object({
  ID: z.string(),
  MessageID: z.string(),
  From: Address,
  To: z.array(Address),
  Subject: z.string(),
  Text: z.string(),
  Date: z.string(),
});
const Headers = z.record(z.string(), z.array(z.string()));

const bracket = (id: string) => (id.startsWith("<") ? id : `<${id}>`);

export function createMailpitMailProvider(options: { smtpUrl?: string; apiUrl?: string } = {}): MailProvider {
  const fakeTokens = createFakeTokenRefresher();
  const smtp = new URL((options.smtpUrl ?? "smtp://127.0.0.1:1025").replace(/^smtp:/, "http:"));
  const api = (options.apiUrl ?? "http://127.0.0.1:8025").replace(/\/$/, "");
  const transport = nodemailer.createTransport({
    host: smtp.hostname,
    port: Number(smtp.port || 1025),
    secure: false,
    ignoreTLS: true,
  });
  const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Mailpit ${String(response.status)}`);
    return schema.parse(await response.json());
  };

  return {
    provider: "microsoft",

    async send(_accessToken, mail) {
      const messageId = `<${randomUUID()}@crm.local>`;
      try {
        await transport.sendMail({
          from: { name: mail.from.name, address: mail.from.email },
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          messageId,
          headers: mail.headers,
        });
      } catch (error) {
        const code = (error as { responseCode?: unknown }).responseCode;
        if (typeof code === "number" && code >= 500)
          throw new MailPermanentError("The mail server rejected the message");
        // A temporary refusal (4xx) or no connection: SMTP accepted nothing, so a retry can't send twice.
        throw new MailRetryableError("The mail server could not be reached");
      }
      return { providerMessageId: messageId, providerThreadId: messageId };
    },

    async listNew(_accessToken, cursor) {
      // Mailpit holds every message; the cursor is the newest Created time already seen.
      const since = cursor === null ? Date.now() : Date.parse(cursor);
      const found = await get("/api/v1/messages?limit=200", SearchResult);
      const fresh = found.messages.filter((message) => Date.parse(message.Created) > since);
      const messages: InboundMail[] = [];
      for (const summary of fresh) {
        const message = await get(`/api/v1/message/${encodeURIComponent(summary.ID)}`, Message);
        const headers = await get(`/api/v1/message/${encodeURIComponent(summary.ID)}/headers`, Headers);
        const parent = (headers["In-Reply-To"]?.[0] ?? headers.References?.[0]?.split(/\s+/)[0])?.trim();
        if (parent === undefined || parent === "") continue; // not a reply to anything: never on a CRM thread
        messages.push({
          providerMessageId: bracket(message.MessageID),
          providerThreadId: bracket(parent),
          fromEmail: message.From.Address.toLowerCase(),
          toEmail: message.To[0]?.Address.toLowerCase() ?? "",
          subject: message.Subject,
          text: message.Text,
          receivedAt: new Date(message.Date),
          bounce: looksLikeBounce(message.From.Address, message.Subject),
        });
      }
      const newest = Math.max(since, ...found.messages.map((message) => Date.parse(message.Created)));
      return { messages, cursor: new Date(newest).toISOString() };
    },

    refresh: (refreshToken) => fakeTokens.refresh(refreshToken),
  };
}
