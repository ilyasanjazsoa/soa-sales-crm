import { randomUUID } from "node:crypto";
import { MailAuthError, MailPermanentError, type InboundMail, type MailProvider, type OutgoingMail } from "./types";

/** In-memory mailbox for tests: records what was sent, and lets a test add replies, bounces and failures. */
export function createMemoryMailProvider() {
  const sent: (OutgoingMail & { accessToken: string; providerMessageId: string })[] = [];
  const inbox: InboundMail[] = [];
  const state = { failRefresh: false, nextSendError: null as Error | null, refreshes: 0 };

  const provider: MailProvider = {
    provider: "microsoft",
    send(accessToken, mail) {
      if (state.nextSendError !== null) {
        const error = state.nextSendError;
        state.nextSendError = null;
        return Promise.reject(error);
      }
      if (mail.to.endsWith(".invalid")) return Promise.reject(new MailPermanentError("Recipient address rejected"));
      const providerMessageId = `<${randomUUID()}@memory.example>`;
      sent.push({ ...mail, accessToken, providerMessageId });
      return Promise.resolve({ providerMessageId, providerThreadId: `thread-${providerMessageId}` });
    },
    listNew(_accessToken, cursor) {
      const start = cursor === null ? 0 : Number(cursor);
      return Promise.resolve({ messages: inbox.slice(start), cursor: String(inbox.length) });
    },
    refresh() {
      state.refreshes += 1;
      if (state.failRefresh) return Promise.reject(new MailAuthError());
      return Promise.resolve({
        accessToken: `memory-access-${randomUUID()}`,
        refreshToken: `memory-refresh-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      });
    },
  };
  return { provider, sent, inbox, state };
}
