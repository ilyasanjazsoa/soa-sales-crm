/* Sending and reading a rep's mailbox (ARCHITECTURE.md §8). One real adapter (Microsoft Graph, DECISIONS.md
   decision 10) and fakes: Mailpit for local development and an in-memory one for tests.
   Only the mail.send job may call `send` (CLAUDE.md rule 2); a test scans the source to keep it that way. */

export interface OutgoingMail {
  from: { email: string; name: string };
  to: string;
  subject: string;
  /** Plain text, footer included. */
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers: Record<string, string>;
}

export interface SentMail {
  providerMessageId: string;
  providerThreadId: string;
}

export interface InboundMail {
  providerMessageId: string;
  providerThreadId: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  text: string;
  receivedAt: Date;
  /** A delivery failure notice (non-delivery report). */
  bounce: boolean;
}

export interface MailTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface MailProvider {
  readonly provider: "microsoft" | "google";
  /** Throws MailRetryableError when nothing was sent, MailPermanentError when it never can be, MailAuthError when
      the rep must reconnect. Any other error means delivery is unknown: the caller must not retry automatically. */
  send: (accessToken: string, mail: OutgoingMail) => Promise<SentMail>;
  /** Messages that arrived since the cursor (null: start from now). Returns the next cursor. */
  listNew: (accessToken: string, cursor: string | null) => Promise<{ messages: InboundMail[]; cursor: string }>;
  refresh: (refreshToken: string) => Promise<MailTokens>;
}

/** The message can never be sent as it is (rejected recipient, invalid message). Not retried. */
export class MailPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailPermanentError";
  }
}

/** The provider definitely did not accept the message (it can be retried without risk of a second copy). */
export class MailRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailRetryableError";
  }
}

/** The sync cursor is no longer valid; start again from now. */
export class MailCursorExpired extends Error {
  constructor() {
    super("The mail sync cursor expired.");
    this.name = "MailCursorExpired";
  }
}

/** The rep's mailbox permission is gone (refresh failed, consent revoked). The rep must reconnect. */
export class MailAuthError extends Error {
  constructor(message = "The mailbox connection has expired.") {
    super(message);
    this.name = "MailAuthError";
  }
}

/** Delivery failure notices are recognised by sender and subject (Exchange and common mail servers). */
export const looksLikeBounce = (fromEmail: string, subject: string) =>
  /^(postmaster|mailer-daemon|microsoftexchange[0-9a-f]*)@/i.test(fromEmail) ||
  /^(undeliverable|delivery (status notification|has failed)|mail delivery failed|returned mail)\b/i.test(subject);
