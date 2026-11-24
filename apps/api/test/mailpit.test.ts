import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { createMailpitMailProvider } from "../src/providers/mail/mailpit";

/* The FAKE_PROVIDERS mail adapter against a real Mailpit (docker compose locally, a service container in CI). */

const API = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";
const SMTP_PORT = Number(
  new URL((process.env.MAILPIT_SMTP_URL ?? "smtp://127.0.0.1:1025").replace("smtp:", "http:")).port,
);

async function findBySubject(subject: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const search = (await (
      await fetch(`${API}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)
    ).json()) as {
      messages: { ID: string }[];
    };
    const [hit] = search.messages;
    if (hit !== undefined) {
      return (await (await fetch(`${API}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
        To: { Address: string }[];
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no message with subject ${subject}`);
}

describe("Mailpit mail provider", () => {
  it("delivers the email with its footer, and reads back only replies to it", async () => {
    const mail = createMailpitMailProvider();
    const subject = `Night coverage ${randomUUID()}`;
    const footer =
      "Priya Raman\nAccount Executive, Security Of America\n\nSecurity Of America · 100 Example Plaza · Unsubscribe: http://localhost:3000/u/abc.def";
    const before = new Date(Date.now() - 1000).toISOString();
    const sent = await mail.send("fake-access", {
      from: { email: "priya@soa.example", name: "Priya Raman" },
      to: "dana@harbor.example",
      subject,
      text: `Hi Dana,\n\nA short note.\n\n${footer}`,
      headers: { "List-Unsubscribe": "<http://localhost:3000/u/abc.def>" },
    });
    const delivered = await findBySubject(subject);
    expect(delivered.To[0]?.Address).toBe("dana@harbor.example");
    expect(delivered.Text.trimEnd().endsWith("Unsubscribe: http://localhost:3000/u/abc.def")).toBe(true);

    // Dana replies on the thread; someone else writes a new, unrelated email to the rep.
    const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: SMTP_PORT, secure: false, ignoreTLS: true });
    await smtp.sendMail({
      from: "dana@harbor.example",
      to: "priya@soa.example",
      subject: `Re: ${subject}`,
      text: "Sounds good, let's talk Tuesday.",
      inReplyTo: sent.providerMessageId,
      references: [sent.providerMessageId],
    });
    await smtp.sendMail({
      from: "friend@elsewhere.example",
      to: "priya@soa.example",
      subject: `Lunch ${subject}`,
      text: "Lunch?",
    });
    await findBySubject(`Lunch ${subject}`);

    const { messages, cursor } = await mail.listNew("fake-access", before);
    const reply = messages.find((message) => message.subject === `Re: ${subject}`);
    expect(reply).toMatchObject({
      providerThreadId: sent.providerMessageId,
      fromEmail: "dana@harbor.example",
      bounce: false,
    });
    expect(reply?.text).toContain("let's talk Tuesday");
    expect(messages.some((message) => message.subject === `Lunch ${subject}`)).toBe(false);
    expect((await mail.listNew("fake-access", cursor)).messages.filter((m) => m.subject.includes(subject))).toEqual([]);
  });
});
