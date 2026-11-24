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
