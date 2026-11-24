import { z } from "zod";
import { unnamedClientMentions } from "./ai";

/* Outreach checks (ARCHITECTURE.md §8.3) as pure functions. They run on every edit and again inside the send
   transaction. Code decides; the AI's claim_check only adds advisory flags (DECISIONS.md decision 6). */

export const Channel = z.enum(["email", "call", "voicemail", "linkedin"]);
export type Channel = z.infer<typeof Channel>;
export const Tone = z.enum(["professional", "friendly", "direct"]);
export type Tone = z.infer<typeof Tone>;

export const CheckResult = z.object({
  id: z.enum(["recipient_ok", "footer", "no_named_client", "subject_present", "length", "phone_ok", "claims"]),
  pass: z.boolean(),
  /** A failed blocking check stops the send; a non-blocking one is a warning. */
  blocking: z.boolean(),
  label: z.string(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const EMAIL_BODY_LIMIT = 1200;
export const LINKEDIN_NOTE_LIMIT = 300;

export interface CheckInput {
  channel: Channel;
  subject: string | null;
  body: string;
  /** The draft continues an existing email thread (then Re: is allowed). */
  isReply: boolean;
  contact: {
    email: string | null;
    emailStatus: "ok" | "unsubscribed" | "bounced";
    phone: string | null;
    phoneType: "business" | "mobile" | "unknown";
    doNotCall: boolean;
  };
  account: { doNotContact: boolean };
  /** The suppression reason when the contact's address is suppressed. */
  suppressionReason: string | null;
  companyPostalAddress: string | null;
  references: readonly { labelNamed: string; namedPermission: boolean }[];
  /** Staging only (MAIL_ALLOWLIST): the only addresses mail may go to. Null means no allowlist. */
  allowlist?: readonly string[] | null;
  /** Advisory flags from the AI claim_check, if it ran. */
  claimFlags?: { absoluteClaims: string[]; disparagement: string[] } | null;
}

export function runChecks(input: CheckInput): CheckResult[] {
  const results: CheckResult[] = [];
  const text = `${input.subject ?? ""}\n${input.body}`;
  const { contact } = input;

  if (input.channel === "email") {
    const reason =
      contact.email === null || contact.email === ""
        ? "The contact has no email address"
        : input.suppressionReason !== null
          ? `${contact.email} is on the suppression list (${input.suppressionReason})`
          : contact.emailStatus !== "ok"
            ? `The contact's email is marked ${contact.emailStatus}`
            : input.account.doNotContact
              ? "The account is marked do not contact"
              : input.allowlist !== undefined &&
                  input.allowlist !== null &&
                  !input.allowlist.includes(contact.email.toLowerCase())
                ? "Staging: this address is not on MAIL_ALLOWLIST"
                : null;
    results.push({
      id: "recipient_ok",
      blocking: true,
      pass: reason === null,
      label: reason ?? "Recipient can be emailed",
    });

    const address = input.companyPostalAddress?.trim() ?? "";
    results.push({
      id: "footer",
      blocking: true,
      pass: address !== "",
      label:
        address === ""
          ? "The company postal address is not set, so email can't be sent (COMPANY_POSTAL_ADDRESS)"
          : "Postal address and unsubscribe link are added automatically",
    });

    const subject = (input.subject ?? "").trim();
    const shouting = /[A-Z]/.test(subject) && subject === subject.toUpperCase();
    const fakeReply = !input.isReply && /^(re|fwd?|fw)\s*:/i.test(subject);
    const subjectProblem =
      subject.length === 0
        ? "Add a subject"
        : subject.length > 120
          ? "The subject is longer than 120 characters"
          : shouting
            ? "The subject is all capitals"
            : fakeReply
              ? "Don't start a new email with Re: or Fwd:"
              : null;
    results.push({
      id: "subject_present",
      blocking: true,
      pass: subjectProblem === null,
      label: subjectProblem ?? "Subject is present and honest",
    });
  } else if (input.channel === "call" || input.channel === "voicemail") {
    const problem = contact.doNotCall
      ? "The contact is on the do-not-call list"
      : contact.phone === null
        ? "The contact has no phone number"
        : null;
    results.push({
      id: "phone_ok",
      blocking: true,
      pass: problem === null,
      label:
        problem ??
        (contact.phoneType === "mobile"
          ? "Mobile number: dial it by hand, never with an auto-dialer"
          : "Not on the do-not-call list"),
    });
  }

  const named = unnamedClientMentions(text, input.references);
  results.push({
    id: "no_named_client",
    blocking: true,
    pass: named.length === 0,
    label:
      named.length === 0
        ? "No client named without permission"
        : `Names a client without permission: “${named.join("”, “")}”`,
  });

  const limit = input.channel === "linkedin" ? LINKEDIN_NOTE_LIMIT : EMAIL_BODY_LIMIT;
  if (input.channel === "email" || input.channel === "linkedin") {
    results.push({
      id: "length",
      blocking: input.channel === "linkedin",
      pass: input.body.length <= limit,
      label:
        input.channel === "linkedin"
          ? `Under LinkedIn's ${String(LINKEDIN_NOTE_LIMIT)}-character limit (${String(input.body.length)})`
          : `Short enough to read on a phone (${String(input.body.length)} of ${String(limit)} characters)`,
    });
  }

  const flags = input.claimFlags;
  if (flags !== undefined && flags !== null) {
    const found = [...flags.absoluteClaims, ...flags.disparagement];
    results.push({
      id: "claims",
      blocking: false,
      pass: found.length === 0,
      label:
        found.length === 0
          ? "No guarantees or digs at the current provider"
          : `AI flag: “${found.slice(0, 3).join("”, “")}”`,
    });
  }
  return results;
}

export const blockingFailures = (results: readonly CheckResult[]) =>
  results.filter((result) => result.blocking && !result.pass);

/** The email footer, appended by code at send time and shown locked in the editor (§8.2). */
export function emailFooter(input: {
  repName: string;
  repTitle: string;
  repPhone: string | null;
  companyName: string;
  postalAddress: string;
  unsubscribeUrl: string;
}): string {
  return [
    input.repName,
    `${input.repTitle}, ${input.companyName}`,
    ...(input.repPhone === null || input.repPhone === "" ? [] : [input.repPhone]),
    "",
    `${input.companyName} · ${input.postalAddress} · Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");
}

/** Reply classes from reply_classify (§7.3). */
export const ReplyClass = z.enum(["interested", "not_now", "not_interested", "out_of_office", "unsubscribe", "other"]);
export type ReplyClass = z.infer<typeof ReplyClass>;

// ───────── API shapes (docs/API.md "Outreach") ─────────
const timestamp = z.iso.datetime({ offset: true });

export const Draft = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  contactId: z.uuid(),
  contact: z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() }),
  dealId: z.uuid().nullable(),
  channel: Channel,
  tone: Tone,
  subject: z.string().nullable(),
  body: z.string(),
  status: z.enum(["draft", "sent", "logged", "discarded"]),
  checks: z.array(CheckResult),
  /** The locked footer the email will end with (email drafts only). */
  footer: z.string().nullable(),
  byAi: z.boolean(),
  updatedAt: timestamp,
});
export type Draft = z.infer<typeof Draft>;
export const DraftList = z.object({
  items: z.array(Draft),
  /** The caller's emails in the last 24 hours against their daily cap (§8.2 step 3). */
  sendsLast24h: z.number().int(),
  dailySendCap: z.number().int(),
});
export type DraftList = z.infer<typeof DraftList>;

export const CreateDraftRequest = z
  .object({
    contactId: z.uuid(),
    channel: Channel,
    tone: Tone.default("professional"),
    useAi: z.boolean().default(false),
  })
  .strict();
export type CreateDraftRequest = z.infer<typeof CreateDraftRequest>;

export const DraftPatch = z
  .object({ subject: z.string().max(300).nullable(), body: z.string().max(20_000), tone: Tone })
  .partial()
  .strict();
export type DraftPatch = z.infer<typeof DraftPatch>;

export const LogOutcomeRequest = z
  .object({
    outcome: z.enum(["connected", "left_voicemail", "no_answer", "wrong_number", "sent"]),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const SendResult = z.object({ messageId: z.uuid(), status: z.literal("queued") });

export const EmailMessage = z.object({
  id: z.uuid(),
  direction: z.enum(["out", "in"]),
  status: z.enum(["queued", "sent", "failed", "bounced", "received"]),
  fromEmail: z.string(),
  toEmail: z.string(),
  subject: z.string(),
  bodyText: z.string(),
  error: z.string().nullable(),
  classification: ReplyClass.nullable(),
  at: timestamp,
});
export type EmailMessage = z.infer<typeof EmailMessage>;
export const EmailList = z.object({ items: z.array(EmailMessage) });

export const Suppression = z.object({
  email: z.string(),
  reason: z.enum(["unsubscribe", "bounce", "complaint", "manual"]),
  note: z.string().nullable(),
  createdAt: timestamp,
});
export type Suppression = z.infer<typeof Suppression>;
export const SuppressionList = z.object({ items: z.array(Suppression) });
export const AddSuppressionRequest = z
  .object({ email: z.email().toLowerCase(), note: z.string().trim().max(300).optional() })
  .strict();

export const DraftOutcome = LogOutcomeRequest.shape.outcome;
export type DraftOutcome = z.infer<typeof DraftOutcome>;

// ───────── AI outputs (§7.3). The model only writes text; code runs every check and decides what happens. ─────────
export const OutreachDraftOutput = z.object({
  subject: z.string().max(200).nullable(),
  body: z.string().min(1).max(4000),
});
export type OutreachDraftOutput = z.infer<typeof OutreachDraftOutput>;

export const ClaimCheckOutput = z.object({
  absoluteClaims: z.array(z.string().max(200)).max(10),
  disparagement: z.array(z.string().max(200)).max(10),
});
export type ClaimCheckOutput = z.infer<typeof ClaimCheckOutput>;

export const ReplyClassifyOutput = z.object({ classification: ReplyClass, summary: z.string().max(200) });
export type ReplyClassifyOutput = z.infer<typeof ReplyClassifyOutput>;

/** Problems with an AI draft beyond its shape, so the client retries once with them (§7.1). */
export function draftProblems(output: OutreachDraftOutput, channel: Channel): string[] {
  const problems: string[] = [];
  if (channel === "email" && (output.subject ?? "").trim() === "") problems.push("An email needs a subject.");
  if (channel === "linkedin" && output.body.length > LINKEDIN_NOTE_LIMIT) {
    problems.push(`The LinkedIn note must be at most ${String(LINKEDIN_NOTE_LIMIT)} characters.`);
  }
  if (/unsubscribe/i.test(output.body)) problems.push("Leave out the footer and unsubscribe line; code adds them.");
  return problems;
}
