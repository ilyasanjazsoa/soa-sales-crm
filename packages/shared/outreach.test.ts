import { describe, expect, it } from "vitest";
import { blockingFailures, emailFooter, runChecks, type CheckInput } from "./outreach";

const input = (overrides: Partial<CheckInput> = {}): CheckInput => ({
  channel: "email",
  subject: "Night coverage at the north yard",
  body: "Hi Dana, a quick note about the yard.",
  isReply: false,
  contact: {
    email: "dana@harbor.example",
    emailStatus: "ok",
    phone: "(214) 555-0100",
    phoneType: "business",
    doNotCall: false,
  },
  account: { doNotContact: false },
  suppressionReason: null,
  companyPostalAddress: "100 Main St, Dallas, TX 75201",
  references: [{ labelNamed: "Lone Star Freight Terminal", namedPermission: false }],
  ...overrides,
});

const failed = (overrides: Partial<CheckInput>) =>
  blockingFailures(runChecks(input(overrides))).map((check) => check.id);

describe("runChecks (email)", () => {
  it("passes a good draft", () => {
    expect(blockingFailures(runChecks(input()))).toEqual([]);
  });

  it.each<[string, Partial<CheckInput>]>([
    ["suppressed address", { suppressionReason: "unsubscribe" }],
    ["bounced contact", { contact: { ...input().contact, emailStatus: "bounced" } }],
    ["unsubscribed contact", { contact: { ...input().contact, emailStatus: "unsubscribed" } }],
    ["no email", { contact: { ...input().contact, email: null } }],
    ["do-not-contact account", { account: { doNotContact: true } }],
  ])("blocks a %s (recipient_ok)", (_label, overrides) => {
    expect(failed(overrides)).toEqual(["recipient_ok"]);
  });

  it("blocks when the company postal address is missing (footer)", () => {
    expect(failed({ companyPostalAddress: null })).toEqual(["footer"]);
    expect(failed({ companyPostalAddress: "  " })).toEqual(["footer"]);
  });

  it("blocks a body or subject that names a client without permission, in any letter case", () => {
    expect(failed({ body: "We also protect LONE STAR FREIGHT TERMINAL." })).toEqual(["no_named_client"]);
    expect(failed({ subject: "Like lone star freight terminal" })).toEqual(["no_named_client"]);
    expect(
      failed({
        references: [{ labelNamed: "Lone Star Freight Terminal", namedPermission: true }],
        body: "Lone Star Freight Terminal",
      }),
    ).toEqual([]);
  });

  it.each([
    ["", "empty"],
    ["x".repeat(121), "too long"],
    ["QUICK QUESTION ABOUT SECURITY", "all capitals"],
    ["Re: our call", "fake reply"],
    ["FWD: proposal", "fake forward"],
  ])("blocks the subject %j (%s)", (subject) => {
    expect(failed({ subject })).toEqual(["subject_present"]);
  });

  it("allows Re: on a reply in an existing thread", () => {
    expect(failed({ subject: "Re: night coverage", isReply: true })).toEqual([]);
  });

  it("warns (doesn't block) on a long email and on AI claim flags", () => {
    const results = runChecks(
      input({ body: "x".repeat(1300), claimFlags: { absoluteClaims: ["guarantee"], disparagement: [] } }),
    );
    expect(blockingFailures(results)).toEqual([]);
    expect(
      results
        .filter((check) => !check.pass)
        .map((check) => check.id)
        .sort(),
    ).toEqual(["claims", "length"]);
  });
});

describe("runChecks (other channels)", () => {
  it("blocks a LinkedIn note over 300 characters", () => {
    expect(failed({ channel: "linkedin", subject: null, body: "x".repeat(301) })).toEqual(["length"]);
    expect(failed({ channel: "linkedin", subject: null, body: "x".repeat(300) })).toEqual([]);
  });

  it("blocks calls and voicemails to do-not-call contacts and warns on mobiles", () => {
    expect(failed({ channel: "call", subject: null, contact: { ...input().contact, doNotCall: true } })).toEqual([
      "phone_ok",
    ]);
    const mobile = runChecks(
      input({ channel: "voicemail", subject: null, contact: { ...input().contact, phoneType: "mobile" } }),
    );
    expect(mobile.find((check) => check.id === "phone_ok")).toMatchObject({
      pass: true,
      label: expect.stringContaining("by hand") as string,
    });
  });

  it("doesn't check email recipients or subjects for calls", () => {
    expect(failed({ channel: "call", subject: null, suppressionReason: "bounce", companyPostalAddress: null })).toEqual(
      [],
    );
  });
});

describe("emailFooter", () => {
  it("matches §8.2", () => {
    expect(
      emailFooter({
        repName: "Priya Raman",
        repTitle: "Account Executive",
        repPhone: "(214) 555-0111",
        companyName: "Security Of America",
        postalAddress: "100 Main St, Dallas, TX 75201",
        unsubscribeUrl: "https://crm.soa.example/u/abc.def",
      }),
    ).toBe(
      "Priya Raman\nAccount Executive, Security Of America\n(214) 555-0111\n\nSecurity Of America · 100 Main St, Dallas, TX 75201 · Unsubscribe: https://crm.soa.example/u/abc.def",
    );
  });
});
