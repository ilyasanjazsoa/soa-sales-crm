import { APP_ROLE, createDb } from "@soa/db";
import { Contract, Proposal, QuoteResponse, type Package } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryQueue } from "../src/jobs/queue";
import { createFakeESignProvider } from "../src/providers/esign/fake";
import { createMemoryObjectStore } from "../src/providers/storage";
import { runProposalRender } from "../src/services/proposals";
import { testDatabaseUrl } from "./db-setup";
import { createUser, ownerQuery, resetDatabase, signIn, testApp, type SignedIn, type TestUser } from "./helpers";

const PRICING_SQL = `INSERT INTO pricing_configs (effective_from, hourly_rate_cents, coverage_hours_per_week, addons, term_discounts)
  VALUES ('2026-01-01', '{"unarmed":2900,"armed":3800}', '{"24_7":168,"nights":84,"business_hours":60}',
  '{"patrol":{"label":"Mobile patrol, 3 visits a night","monthlyCents":145000},"video":{"label":"Remote video monitoring","monthlyCents":220000},"portal":{"label":"Client portal with live officer map","monthlyCents":0}}',
  '{"12":0,"24":0.03,"36":0.05}')`;
const REFERENCE: Package = {
  posts: 2,
  armed: false,
  coverage: "24_7",
  supervisor: false,
  addons: ["video"],
  termMonths: 36,
};
const WEBHOOK_KEY = "test-webhook-key";

let app: FastifyInstance;
let ae: TestUser;
let session: SignedIn;
let accountId: string;
let dealId: string;
let contactId: string;
const queue = createMemoryQueue();
const store = createMemoryObjectStore();
let esign = createFakeESignProvider({ webhookKey: WEBHOOK_KEY });
const as = (who: SignedIn = session) => ({ cookies: who.cookies, headers: who.headers });

beforeEach(async () => {
  await resetDatabase();
  queue.sent.length = 0;
  esign = createFakeESignProvider({ webhookKey: WEBHOOK_KEY });
  await ownerQuery(PRICING_SQL);
  ae = await createUser("priya@soa.example", "ae", { name: "Priya Raman" });
  await ownerQuery("UPDATE users SET phone = '(214) 555-0111' WHERE id = $1", [ae.id]);
  const [account] = await ownerQuery<{ id: string }>(
    "INSERT INTO accounts (name, property_type, address_line, city, state, owner_user_id) VALUES ('Harbor Freight Yards', 'Industrial', '2400 Harbor Rd', 'Irving', 'TX', $1) RETURNING id",
    [ae.id],
  );
  accountId = account?.id ?? "";
  const [contact] = await ownerQuery<{ id: string }>(
    "INSERT INTO contacts (account_id, first_name, last_name, email, is_primary) VALUES ($1, 'Dana', 'Whitfield', 'dana@harbor.example', true) RETURNING id",
    [accountId],
  );
  contactId = contact?.id ?? "";
  const [deal] = await ownerQuery<{ id: string }>(
    "INSERT INTO deals (account_id, owner_user_id, name, stage) VALUES ($1, $2, 'Deal', 'meeting_set') RETURNING id",
    [accountId, ae.id],
  );
  dealId = deal?.id ?? "";
  app = await testApp({
    env: {
      COMPANY_POSTAL_ADDRESS: "100 Example Plaza, Dallas, TX 75201",
      COMPANY_SIGNER_NAME: "Jordan Hale",
      COMPANY_SIGNER_EMAIL: "jordan.hale@soa.example",
    },
    queue,
    store,
    esign: esign.provider,
  });
  session = await signIn(app, ae.email);
});
afterEach(async () => {
  await app.close();
});

const createProposal = async (body: Record<string, unknown> = {}) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/deals/${dealId}/proposals`,
    ...as(),
    payload: { package: REFERENCE, ...body },
  });
  expect(response.statusCode, response.body).toBe(201);
  return Proposal.parse(response.json());
};

async function render(proposalId: string) {
  const handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 2 });
  try {
    await runProposalRender(
      {
        db: handle.db,
        store,
        config: { COMPANY_NAME: "Security Of America", COMPANY_POSTAL_ADDRESS: "100 Example Plaza, Dallas, TX 75201" },
        clock: () => new Date(),
      },
      { proposalId },
    );
  } finally {
    await handle.close();
  }
}

const sendProposal = async (id: string) => {
  await app.inject({ method: "POST", url: `/api/proposals/${id}/render`, ...as() });
  await render(id);
  return app.inject({ method: "POST", url: `/api/proposals/${id}/send`, ...as(), payload: {} });
};

async function pdfText(pdf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const content = await (await document.getPage(index)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return pages.join("\n");
}

describe("pricing", () => {
  it("quotes the reference case exactly: 50,643,360 cents a year, 4,220,280 a month", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/pricing/quote",
      ...as(),
      payload: { package: REFERENCE },
    });
    const quote = QuoteResponse.parse(response.json());
    expect(quote.breakdown).toMatchObject({ hoursPerWeek: 336, annualCents: 50_643_360, monthlyCents: 4_220_280 });
  });

  it("ignores prices from the browser: the stored price is always the engine's", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/proposals`,
      ...as(),
      payload: { package: REFERENCE, pricing: { annualCents: 100, monthlyCents: 8 } },
    });
    expect(rejected.statusCode).toBe(400);
    const proposal = await createProposal();
    expect(proposal.pricing).toMatchObject({ annualCents: 50_643_360, monthlyCents: 4_220_280 });
    const [row] = await ownerQuery<{ pricing: { annualCents: number } }>("SELECT pricing FROM proposals");
    expect(row?.pricing.annualCents).toBe(50_643_360);
  });

  it("lets managers add a version; a sent proposal keeps its numbers", async () => {
    const proposal = await createProposal();
    expect((await sendProposal(proposal.id)).statusCode).toBe(200);
    const manager = await createUser("max@soa.example", "manager");
    const managerSession = await signIn(app, manager.email);
    const today = new Date().toISOString().slice(0, 10);
    const config = {
      effectiveFrom: today,
      hourlyRateCents: { unarmed: 3500, armed: 4500 },
      coverageHoursPerWeek: { "24_7": 168, nights: 84, business_hours: 60 },
      supervisorMultiplier: 1.05,
      addons: {
        patrol: { label: "Mobile patrol", monthlyCents: 150000 },
        video: { label: "Remote video monitoring", monthlyCents: 250000 },
        portal: { label: "Client portal", monthlyCents: 0 },
      },
      termDiscounts: { "12": 0, "24": 0.03, "36": 0.05 },
      maxManualDiscount: 0.1,
    };
    expect(
      (await app.inject({ method: "POST", url: "/api/pricing/config", ...as(), payload: config })).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/api/pricing/config",
      ...as(managerSession),
      payload: config,
    });
    expect(created.statusCode, created.body).toBe(201);
    const quote = QuoteResponse.parse(
      (
        await app.inject({ method: "POST", url: "/api/pricing/quote", ...as(), payload: { package: REFERENCE } })
      ).json(),
    );
    expect(quote.breakdown.annualCents).not.toBe(50_643_360); // the new version is live
    const after = Proposal.parse(
      (await app.inject({ method: "GET", url: `/api/proposals/${proposal.id}`, ...as() })).json(),
    );
    expect(after.pricing).toMatchObject({ annualCents: 50_643_360, monthlyCents: 4_220_280 });
    const audit = await ownerQuery<{ action: string }>("SELECT action FROM audit_log WHERE action = 'pricing.create'");
    expect(audit).toHaveLength(1);
  });
});

describe("proposals", () => {
  it("blocks sending a discount above the limit until a manager approves it (audited)", async () => {
    const proposal = await createProposal({ manualDiscount: 0.15 });
    expect(proposal.needsApproval).toBe(true);
    const blocked = await sendProposal(proposal.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe("needs_approval");

    expect(
      (await app.inject({ method: "POST", url: `/api/proposals/${proposal.id}/approve-discount`, ...as() })).statusCode,
    ).toBe(403);
    const manager = await createUser("max@soa.example", "manager");
    const managerSession = await signIn(app, manager.email);
    const approved = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/approve-discount`,
      ...as(managerSession),
    });
    expect(Proposal.parse(approved.json()).needsApproval).toBe(false);
    const [audit] = await ownerQuery<{ action: string; user_id: string; meta: { manualDiscount: number } }>(
      "SELECT action, user_id, meta FROM audit_log WHERE action = 'proposal.discount_approve'",
    );
    expect(audit).toMatchObject({ user_id: manager.id, meta: { manualDiscount: 0.15 } });
    expect((await sendProposal(proposal.id)).statusCode).toBe(200);
  });

  it("renders a PDF with the account, every line, the prices and the rep's contact details", async () => {
    const proposal = await createProposal({ package: { ...REFERENCE, addons: ["video", "patrol"] } });
    await render(proposal.id);
    const pdf = await app.inject({ method: "GET", url: `/api/proposals/${proposal.id}/pdf`, ...as() });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const text = await pdfText(pdf.rawPayload);
    const current = Proposal.parse(
      (await app.inject({ method: "GET", url: `/api/proposals/${proposal.id}`, ...as() })).json(),
    );
    expect(text).toContain("Harbor Freight Yards");
    for (const line of current.lines) expect(text).toContain(line);
    const money = (cents: number) =>
      `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(text).toContain(money(current.pricing.monthlyCents));
    expect(text).toContain(money(current.pricing.annualCents));
    expect(text).toContain("Priya Raman");
    expect(text).toContain("priya@soa.example");
    expect(text).toContain("(214) 555-0111");
  });

  it("sending creates a 30-day link and an email draft with it, and moves the deal to proposal", async () => {
    const proposal = await createProposal();
    const sent = await sendProposal(proposal.id);
    const body = sent.json<{ draftId: string; expiresAt: string }>();
    const [draft] = await ownerQuery<{ body: string; status: string }>(
      "SELECT body, status FROM outreach_drafts WHERE id = $1",
      [body.draftId],
    );
    expect(draft?.status).toBe("draft"); // the rep still reviews and sends it
    expect(draft?.body).toMatch(/http:\/\/localhost:3000\/p\/[\w-]{43}/);
    const [deal] = await ownerQuery<{ stage: string; annual_value_cents: number }>(
      "SELECT stage, annual_value_cents FROM deals",
    );
    expect({ ...deal, annual_value_cents: Number(deal?.annual_value_cents) }).toMatchObject({
      stage: "proposal",
      annual_value_cents: 50_643_360,
    });
    const [row] = await ownerQuery<{ public_token_hash: string }>("SELECT public_token_hash FROM proposals");
    expect(draft?.body).not.toContain(row?.public_token_hash); // only the hash is stored
  });
});

describe("public proposal link (/p/:token)", () => {
  const linkOf = async () => {
    const proposal = await createProposal();
    const sent = await sendProposal(proposal.id);
    const [draft] = await ownerQuery<{ body: string }>("SELECT body FROM outreach_drafts WHERE id = $1", [
      sent.json<{ draftId: string }>().draftId,
    ]);
    return { proposal, path: /http:\/\/localhost:3000(\/p\/[\w-]+)/.exec(draft?.body ?? "")?.[1] ?? "" };
  };

  it("works without a session, records a view, and serves the PDF", async () => {
    const { proposal, path } = await linkOf();
    const page = await app.inject({ method: "GET", url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Harbor Freight Yards");
    expect(page.body).toContain("Contact Priya Raman");
    expect(String(page.headers["content-security-policy"])).toContain("frame-src 'self'");
    const file = await app.inject({ method: "GET", url: `${path}?format=pdf` });
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(String(file.headers["content-security-policy"])).toContain("frame-ancestors 'self'");
    await app.inject({ method: "GET", url: path });
    const after = Proposal.parse(
      (await app.inject({ method: "GET", url: `/api/proposals/${proposal.id}`, ...as() })).json(),
    );
    expect(after).toMatchObject({ viewCount: 2, status: "viewed" });
    const [views] = await ownerQuery<{ ip_hash: string }>("SELECT ip_hash FROM proposal_views LIMIT 1");
    expect(views?.ip_hash).toMatch(/^[0-9a-f]{64}$/); // only a salted hash
    expect(await ownerQuery("SELECT id FROM activities WHERE type = 'proposal_viewed'")).toHaveLength(1); // first view a day
  });

  it("returns 404 for a wrong or expired token", async () => {
    const { path } = await linkOf();
    expect((await app.inject({ method: "GET", url: `/p/${"x".repeat(43)}` })).statusCode).toBe(404);
    await ownerQuery("UPDATE proposals SET expires_at = now() - interval '1 minute'");
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
  });

  it("is rate limited to 30 a minute per address", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      statuses.push((await app.inject({ method: "GET", url: `/p/${"y".repeat(43)}` })).statusCode);
    }
    expect(statuses.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("contracts and the e-signature webhook", () => {
  const multipart = (json: string) => {
    const boundary = "----soaBoundary";
    return {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="json"\r\n\r\n${json}\r\n--${boundary}--\r\n`,
    };
  };
  const sendContract = async () => {
    const proposal = await createProposal();
    await sendProposal(proposal.id);
    const response = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/contract`,
      ...as(),
      payload: { signerContactId: contactId, startDate: "2026-12-01" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const contract = Contract.parse(response.json());
    const [row] = await ownerQuery<{ provider_envelope_id: string }>("SELECT provider_envelope_id FROM contracts");
    return { contract, envelopeId: row?.provider_envelope_id ?? "" };
  };

  it("sends the envelope with the contact first and the company signer second, and moves the deal", async () => {
    const { envelopeId } = await sendContract();
    expect(esign.envelopes.get(envelopeId)?.signers).toEqual(["dana@harbor.example", "jordan.hale@soa.example"]);
    const [deal] = await ownerQuery<{ stage: string }>("SELECT stage FROM deals");
    expect(deal?.stage).toBe("contract_sent");
  });

  it("rejects a bad signature", async () => {
    const { envelopeId } = await sendContract();
    const forged = createFakeESignProvider({ webhookKey: "not-the-key" }).callback("signed", envelopeId);
    const response = await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(forged) });
    expect(response.statusCode).toBe(401);
    expect(await ownerQuery("SELECT status FROM contracts")).toEqual([{ status: "sent" }]);
  });

  it("stores the signed PDF, wins the deal and creates the hand-off task once; a replay changes nothing", async () => {
    const { contract, envelopeId } = await sendContract();
    const event = esign.callback("signed", envelopeId);
    const first = await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(event) });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).toBe("Hello API Event Received");
    const snapshot = async () => ({
      contracts: await ownerQuery("SELECT status, signed_at, signed_pdf_object_key, view_count FROM contracts"),
      deals: await ownerQuery("SELECT stage, status FROM deals"),
      tasks: await ownerQuery("SELECT title FROM tasks"),
      activities: await ownerQuery("SELECT count(*)::int AS n FROM activities"),
    });
    const after = await snapshot();
    expect(after.deals).toEqual([{ stage: "won", status: "won" }]);
    expect(after.tasks).toEqual([{ title: "Hand off Harbor Freight Yards to operations" }]);
    const signed = Contract.parse(
      (await app.inject({ method: "GET", url: `/api/contracts/${contract.id}`, ...as() })).json(),
    );
    expect(signed.status).toBe("signed");
    const download = await app.inject({ method: "GET", url: signed.signedPdfUrl ?? "", ...as() });
    expect(download.headers["content-type"]).toBe("application/pdf");

    const replay = await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(event) });
    expect(replay.statusCode).toBe(200);
    expect(await snapshot()).toEqual(after);
  });

  it("counts views and records a decline with a task for the rep", async () => {
    const { envelopeId } = await sendContract();
    const at = (secondsAgo: number) => String(Math.floor(Date.now() / 1000) - secondsAgo);
    await app.inject({
      method: "POST",
      url: "/webhooks/esign",
      ...multipart(esign.callback("viewed", envelopeId, at(3))),
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/esign",
      ...multipart(esign.callback("viewed", envelopeId, at(2))),
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/esign",
      ...multipart(esign.callback("declined", envelopeId, at(1))),
    });
    expect(await ownerQuery("SELECT status, view_count FROM contracts")).toEqual([
      { status: "declined", view_count: 2 },
    ]);
    expect(await ownerQuery("SELECT title FROM tasks")).toEqual([
      { title: "Follow up: the contract for Harbor Freight Yards was declined" },
    ]);
  });

  it("refuses a contract before the proposal is sent, and a second open one", async () => {
    const proposal = await createProposal();
    const early = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/contract`,
      ...as(),
      payload: { signerContactId: contactId, startDate: "2026-12-01" },
    });
    expect(early.statusCode).toBe(409);
  });
});

describe("review fixes", () => {
  const multipart = (json: string) => {
    const boundary = "----soaBoundary";
    return {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="json"\r\n\r\n${json}\r\n--${boundary}--\r\n`,
    };
  };
  const contractFor = async () => {
    const proposal = await createProposal();
    await sendProposal(proposal.id);
    const response = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/contract`,
      ...as(),
      payload: { signerContactId: contactId, startDate: "2026-12-01" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const [row] = await ownerQuery<{ provider_envelope_id: string }>("SELECT provider_envelope_id FROM contracts");
    return { proposal, envelopeId: row?.provider_envelope_id ?? "" };
  };

  it("a signed contract wins its own deal, never another open one on the account", async () => {
    const { envelopeId } = await contractFor();
    await ownerQuery("UPDATE deals SET status = 'lost', lost_reason = 'Price' WHERE id = $1", [dealId]);
    const [other] = await ownerQuery<{ id: string }>(
      "INSERT INTO deals (account_id, owner_user_id, name, stage) VALUES ($1, $2, 'Second try', 'contacted') RETURNING id",
      [accountId, ae.id],
    );
    await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(esign.callback("signed", envelopeId)) });
    expect(await ownerQuery("SELECT stage, status FROM deals WHERE id = $1", [other?.id])).toEqual([
      { stage: "contacted", status: "open" },
    ]);
    const [task] = await ownerQuery<{ title: string }>("SELECT title FROM tasks");
    expect(task?.title).toContain("signed on a closed deal");
  });

  it("a callback naming an envelope that isn't actually complete changes nothing", async () => {
    const { envelopeId } = await contractFor();
    // An authentic body replayed with another envelope id still verifies (the hash doesn't cover the id).
    const forged = JSON.stringify({
      ...(JSON.parse(esign.callback("signed", "fake-envelope-other")) as Record<string, unknown>),
      signature_request: { signature_request_id: envelopeId },
    });
    const response = await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(forged) });
    expect(response.statusCode).toBe(200);
    expect(await ownerQuery("SELECT status FROM contracts")).toEqual([{ status: "sent" }]);
    expect(await ownerQuery("SELECT stage FROM deals")).toEqual([{ stage: "contract_sent" }]);
  });

  it("rejects an old callback", async () => {
    const { envelopeId } = await contractFor();
    const old = esign.callback("signed", envelopeId, String(Math.floor(Date.now() / 1000) - 4 * 86_400));
    expect((await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(old) })).statusCode).toBe(401);
  });

  it("never re-renders a sent proposal's PDF", async () => {
    const proposal = await createProposal();
    await sendProposal(proposal.id);
    const [before] = await ownerQuery<{ pdf_object_key: string }>("SELECT pdf_object_key FROM proposals");
    const again = await app.inject({ method: "POST", url: `/api/proposals/${proposal.id}/render`, ...as() });
    expect(again.statusCode).toBe(409);
    await render(proposal.id); // a stale job does nothing either
    expect(await ownerQuery("SELECT pdf_object_key FROM proposals")).toEqual([before]);
  });

  it("an approval doesn't survive a change to the package", async () => {
    const proposal = await createProposal({ manualDiscount: 0.15 });
    const manager = await createUser("max@soa.example", "manager");
    const managerSession = await signIn(app, manager.email);
    await app.inject({ method: "POST", url: `/api/proposals/${proposal.id}/approve-discount`, ...as(managerSession) });
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/proposals/${proposal.id}`,
      ...as(),
      payload: { package: { ...REFERENCE, posts: 10, armed: true } },
    });
    expect(Proposal.parse(changed.json()).needsApproval).toBe(true);
  });

  it("refuses to send a proposal to a contact who can't be emailed, before changing anything", async () => {
    const proposal = await createProposal();
    await app.inject({ method: "POST", url: `/api/proposals/${proposal.id}/render`, ...as() });
    await render(proposal.id);
    await ownerQuery("INSERT INTO suppressions (email, reason) VALUES ('dana@harbor.example', 'unsubscribe')");
    const response = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/send`,
      ...as(),
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(await ownerQuery("SELECT status FROM proposals")).toEqual([{ status: "draft" }]);
  });

  it("marks the proposal accepted when the contract is signed", async () => {
    const { envelopeId } = await contractFor();
    await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(esign.callback("signed", envelopeId)) });
    expect(await ownerQuery("SELECT status FROM proposals")).toEqual([{ status: "accepted" }]);
  });
});

describe("security review fixes", () => {
  const multipart = (json: string) => {
    const boundary = "----soaBoundary";
    return {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="json"\r\n\r\n${json}\r\n--${boundary}--\r\n`,
    };
  };
  const tryContract = async () => {
    const proposal = await createProposal();
    await sendProposal(proposal.id);
    return app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/contract`,
      ...as(),
      payload: { signerContactId: contactId, startDate: "2026-12-01" },
    });
  };

  it("refuses an e-signature request to a do-not-contact account", async () => {
    const proposal = await createProposal();
    await sendProposal(proposal.id);
    await ownerQuery("UPDATE accounts SET do_not_contact = true");
    const response = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/contract`,
      ...as(),
      payload: { signerContactId: contactId, startDate: "2026-12-01" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("do not contact");
  });

  it("staging (MAIL_ALLOWLIST) refuses a signer outside the list", async () => {
    await app.close();
    app = await testApp({
      env: {
        COMPANY_POSTAL_ADDRESS: "100 Example Plaza, Dallas, TX 75201",
        COMPANY_SIGNER_NAME: "Jordan Hale",
        COMPANY_SIGNER_EMAIL: "jordan.hale@soa.example",
        MAIL_ALLOWLIST: "tester@soa.example,dana@harbor.example",
      },
      queue,
      store,
      esign: esign.provider,
    });
    session = await signIn(app, ae.email);
    expect((await tryContract()).statusCode).toBe(201);
    await ownerQuery("UPDATE contracts SET status = 'voided'");
    await ownerQuery("UPDATE contacts SET email = 'someone@else.example'");
    const proposal = await createProposal();
    await ownerQuery("UPDATE proposals SET status = 'sent', expires_at = now() + interval '1 day' WHERE id = $1", [
      proposal.id,
    ]);
    const refused = await app.inject({
      method: "POST",
      url: `/api/proposals/${proposal.id}/contract`,
      ...as(),
      payload: { signerContactId: contactId, startDate: "2026-12-01" },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain("MAIL_ALLOWLIST");
  });

  it("ignores a 'viewed' callback replayed against an envelope that doesn't exist", async () => {
    const response = await tryContract();
    expect(response.statusCode).toBe(201);
    const forged = esign.callback("viewed", "fake-envelope-nobody-made");
    await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(forged) });
    const old = esign.callback(
      "viewed",
      (await ownerQuery<{ e: string }>("SELECT provider_envelope_id AS e FROM contracts"))[0]?.e ?? "",
      String(Math.floor(Date.now() / 1000) - 2 * 3600),
    );
    await app.inject({ method: "POST", url: "/webhooks/esign", ...multipart(old) });
    expect(await ownerQuery("SELECT view_count FROM contracts")).toEqual([{ view_count: 0 }]);
  });
});
