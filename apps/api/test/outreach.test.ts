import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_ROLE, createDb } from "@soa/db";
import { Draft, EmailList } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenCipher } from "../src/auth/crypto";
import { createMemoryQueue } from "../src/jobs/queue";
import { createAiClient } from "../src/providers/ai/client";
import { createFakeAiAdapter } from "../src/providers/ai/fake";
import { createMemoryMailProvider } from "../src/providers/mail/memory";
import { runMailSend, runMailSync, syncableUsers } from "../src/services/mail-jobs";
import { testDatabaseUrl } from "./db-setup";
import { createUser, ownerQuery, resetDatabase, signIn, testApp, type SignedIn, type TestUser } from "./helpers";

const TOKEN_ENC_KEY = "a".repeat(64);
const UNSUBSCRIBE_SECRET = "b".repeat(64);
const POSTAL = "100 Example Plaza, Dallas, TX 75201";
const ENV = { TOKEN_ENC_KEY, UNSUBSCRIBE_SECRET, COMPANY_POSTAL_ADDRESS: POSTAL };

let app: FastifyInstance;
let ae: TestUser;
let session: SignedIn;
let accountId: string;
let contactId: string;
let dealId: string;
const queue = createMemoryQueue();
const adapter = createFakeAiAdapter();
let mailbox = createMemoryMailProvider();
const as = (who: SignedIn = session) => ({ cookies: who.cookies, headers: who.headers });

async function arrange(email: string, ownerId: string, name: string) {
  const [account] = await ownerQuery<{ id: string }>(
    "INSERT INTO accounts (name, property_type, city, owner_user_id) VALUES ($1, 'Industrial', 'Irving', $2) RETURNING id",
    [name, ownerId],
  );
  const [contact] = await ownerQuery<{ id: string }>(
    "INSERT INTO contacts (account_id, first_name, last_name, title, email, phone, is_primary) VALUES ($1, 'Dana', 'Whitfield', 'Property Manager', $2, '(214) 555-0100', true) RETURNING id",
    [account?.id, email],
  );
  const [deal] = await ownerQuery<{ id: string }>(
    "INSERT INTO deals (account_id, owner_user_id, name, stage) VALUES ($1, $2, 'Deal', 'researched') RETURNING id",
    [account?.id, ownerId],
  );
  return { accountId: account?.id ?? "", contactId: contact?.id ?? "", dealId: deal?.id ?? "" };
}

beforeEach(async () => {
  await resetDatabase();
  queue.sent.length = 0;
  adapter.calls.length = 0;
  mailbox = createMemoryMailProvider();
  ae = await createUser("priya@soa.example", "ae", { name: "Priya Raman" });
  await ownerQuery("UPDATE users SET phone = '(214) 555-0111' WHERE id = $1", [ae.id]);
  ({ accountId, contactId, dealId } = await arrange("dana@harbor.example", ae.id, "Harbor Freight Yards"));
  app = await testApp({ env: ENV, queue, aiAdapter: adapter });
  session = await signIn(app, ae.email);
});
afterEach(async () => {
  await app.close();
});

/** Runs the mail jobs the api queued, the way the worker does. */
async function runWorker(options: { finalAttempt?: boolean } = {}) {
  const handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 2 });
  const deps = {
    db: handle.db,
    mail: mailbox.provider,
    cipher: createTokenCipher(TOKEN_ENC_KEY),
    ai: createAiClient({
      db: handle.db,
      adapter,
      config: { AI_MODEL_WRITER: "w", AI_MODEL_FAST: "f" },
      clock: () => new Date(),
    }),
    clock: () => new Date(),
    config: { PUBLIC_URL: "http://localhost:3000", UNSUBSCRIBE_SECRET, MAIL_ALLOWLIST: undefined },
  };
  try {
    for (const job of queue.sent.splice(0)) {
      if (job.name === "mail.send") {
        await runMailSend(deps, job.data as { messageId: string }, { finalAttempt: options.finalAttempt ?? false });
      }
    }
    return {
      sync: (userId: string) => runMailSync(deps, { userId }),
      syncable: () => syncableUsers(handle.db),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function sendJobs() {
  const worker = await runWorker();
  await worker.close();
}

const createDraft = async (
  body: Record<string, unknown> = {},
  who = session,
  account = accountId,
  contact = contactId,
) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/accounts/${account}/drafts`,
    ...as(who),
    payload: { contactId: contact, channel: "email", useAi: true, ...body },
  });
  expect(response.statusCode, response.body).toBe(201);
  return Draft.parse(response.json());
};
const send = (id: string, who = session) => app.inject({ method: "POST", url: `/api/drafts/${id}/send`, ...as(who) });

describe("drafts", () => {
  it("writes an email with AI, runs every check, and shows the locked footer", async () => {
    const draft = await createDraft();
    expect(draft.byAi).toBe(true);
    expect(draft.subject).toContain("Harbor Freight Yards");
    expect(draft.checks.map((check) => check.id).sort()).toEqual(
      ["claims", "footer", "length", "no_named_client", "recipient_ok", "subject_present"].sort(),
    );
    expect(draft.checks.every((check) => check.pass)).toBe(true);
    expect(draft.footer).toContain("Priya Raman");
    expect(draft.footer).toContain(POSTAL);
    expect(draft.footer).toMatch(/Unsubscribe: http:\/\/localhost:3000\/u\/[\w-]+\.[\w-]+$/);
    const features = adapter.calls.map((call) => call.feature);
    expect(features).toEqual(["outreach_draft", "claim_check"]);
  });

  it("re-runs the checks on every save and flags an AI-found claim as a warning only", async () => {
    const draft = await createDraft({ useAi: false });
    expect(draft.checks.find((check) => check.id === "subject_present")?.pass).toBe(false);
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/drafts/${draft.id}`,
      ...as(),
      payload: { subject: "Night coverage", body: "Hi Dana, a short note." },
    });
    expect(Draft.parse(saved.json()).checks.every((check) => check.pass)).toBe(true);
  });

  it("logs a call, and refuses a LinkedIn note over 300 characters", async () => {
    const call = await createDraft({ channel: "call" });
    const logged = await app.inject({
      method: "POST",
      url: `/api/drafts/${call.id}/log`,
      ...as(),
      payload: { outcome: "connected", note: "Wants a site walk." },
    });
    expect(logged.statusCode, logged.body).toBe(200);
    expect(Draft.parse(logged.json()).status).toBe("logged");
    const [stage] = await ownerQuery<{ stage: string }>("SELECT stage FROM deals WHERE id = $1", [dealId]);
    expect(stage?.stage).toBe("contacted");

    const note = await createDraft({ channel: "linkedin", useAi: false });
    await app.inject({ method: "PATCH", url: `/api/drafts/${note.id}`, ...as(), payload: { body: "x".repeat(301) } });
    const refused = await app.inject({
      method: "POST",
      url: `/api/drafts/${note.id}/log`,
      ...as(),
      payload: { outcome: "sent" },
    });
    expect(refused.statusCode).toBe(422);
  });

  it("are personal: another rep can't read, edit or send them", async () => {
    const draft = await createDraft();
    const other = await createUser("lee@soa.example");
    const otherSession = await signIn(app, other.email);
    expect((await app.inject({ method: "GET", url: `/api/drafts/${draft.id}`, ...as(otherSession) })).statusCode).toBe(
      404,
    );
    expect((await send(draft.id, otherSession)).statusCode).toBe(404);
  });
});

describe("sending (§8.2)", () => {
  it("sends with the rep's signature, the postal address and an unsubscribe link, and moves the deal to contacted", async () => {
    const draft = await createDraft();
    const response = await send(draft.id);
    expect(response.statusCode, response.body).toBe(202);
    expect(queue.sent.map((job) => job.name)).toEqual(["mail.send"]);
    await sendJobs();

    expect(mailbox.sent).toHaveLength(1);
    const mail = mailbox.sent[0];
    expect(mail?.to).toBe("dana@harbor.example");
    expect(mail?.from.email).toBe("priya@soa.example");
    expect(mail?.text.trimEnd()).toMatch(
      new RegExp(
        `Priya Raman\\nAccount Executive, Security Of America\\n\\(214\\) 555-0111\\n\\nSecurity Of America · ${POSTAL} · Unsubscribe: http://localhost:3000/u/[\\w-]+\\.[\\w-]+$`,
      ),
    );
    expect(mail?.headers["List-Unsubscribe"]).toMatch(/^<http:\/\/localhost:3000\/u\//);

    const [message] = await ownerQuery<{ status: string; provider_thread_id: string }>(
      "SELECT status, provider_thread_id FROM email_messages",
    );
    expect(message?.status).toBe("sent");
    const [deal] = await ownerQuery<{ stage: string }>("SELECT stage FROM deals WHERE id = $1", [dealId]);
    expect(deal?.stage).toBe("contacted");
    const audit = await ownerQuery<{ action: string }>("SELECT action FROM audit_log ORDER BY created_at");
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(["email.send", "deal.stage"]));
    const emails = EmailList.parse(
      (await app.inject({ method: "GET", url: `/api/accounts/${accountId}/emails`, ...as() })).json(),
    );
    expect(emails.items).toHaveLength(1);
  });

  it("sends one message when the same draft is sent twice in parallel", async () => {
    const draft = await createDraft();
    const results = await Promise.all([send(draft.id), send(draft.id)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([202, 409]);
    await sendJobs();
    expect(mailbox.sent).toHaveLength(1);
    expect(await ownerQuery("SELECT id FROM email_messages")).toHaveLength(1);
  });

  it.each<[string, () => Promise<unknown>, string]>([
    [
      "a suppressed address",
      () => ownerQuery("INSERT INTO suppressions (email, reason) VALUES ('dana@harbor.example', 'manual')"),
      "recipient_ok",
    ],
    ["a bounced contact", () => ownerQuery("UPDATE contacts SET email_status = 'bounced'"), "recipient_ok"],
    ["a do-not-contact account", () => ownerQuery("UPDATE accounts SET do_not_contact = true"), "recipient_ok"],
    [
      "a body naming a client without permission",
      () =>
        ownerQuery(
          "INSERT INTO client_references (label_named, label_anonymized, property_types, named_permission, stats) VALUES ('Lone Star Freight Terminal', 'a freight terminal in Irving', '{Industrial}', false, '{}')",
        ),
      "no_named_client",
    ],
  ])("is refused with 422 for %s", async (_label, arrangeCase, check) => {
    const draft = await createDraft();
    await arrangeCase();
    if (check === "no_named_client") {
      await app.inject({
        method: "PATCH",
        url: `/api/drafts/${draft.id}`,
        ...as(),
        payload: { body: `${draft.body}\nWe also protect lone star freight terminal.` },
      });
    }
    const response = await send(draft.id);
    expect(response.statusCode).toBe(422);
    expect(
      response.json<{ error: { details: { checks: { id: string }[] } } }>().error.details.checks.map((c) => c.id),
    ).toContain(check);
    expect(queue.sent).toHaveLength(0);
    expect(await ownerQuery("SELECT id FROM email_messages")).toHaveLength(0);
  });

  it("is refused with 422 when the company postal address is missing", async () => {
    await app.close();
    app = await testApp({ env: { TOKEN_ENC_KEY, UNSUBSCRIBE_SECRET }, queue, aiAdapter: adapter });
    session = await signIn(app, ae.email);
    const draft = await createDraft();
    const response = await send(draft.id);
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("footer");
  });

  it("returns 429 on the 51st send in 24 hours", async () => {
    await ownerQuery(
      `INSERT INTO email_messages (user_id, account_id, direction, status, provider, from_email, to_email, subject, body_text)
       SELECT $1, $2, 'out', 'sent', 'microsoft', 'priya@soa.example', 'someone@other.example', 'Hi', 'Body' FROM generate_series(1, 50)`,
      [ae.id, accountId],
    );
    const draft = await createDraft();
    const response = await send(draft.id);
    expect(response.statusCode).toBe(429);
    expect(queue.sent).toHaveLength(0);
  });

  it("honours MAIL_ALLOWLIST", async () => {
    await app.close();
    app = await testApp({ env: { ...ENV, MAIL_ALLOWLIST: "tester@soa.example" }, queue, aiAdapter: adapter });
    session = await signIn(app, ae.email);
    const draft = await createDraft();
    const response = await send(draft.id);
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("MAIL_ALLOWLIST");
  });

  it("fails a permanent error at once and shows it, and Retry re-queues the same row", async () => {
    await ownerQuery("UPDATE contacts SET email = 'dana@harbor.invalid'");
    const draft = await createDraft();
    expect((await send(draft.id)).statusCode).toBe(202);
    await sendJobs();
    const [failed] = await ownerQuery<{ id: string; status: string; error: string }>(
      "SELECT id, status, error FROM email_messages",
    );
    expect(failed?.status).toBe("failed");
    const timeline = await ownerQuery<{ subject: string }>(
      "SELECT subject FROM activities WHERE type = 'email_out' ORDER BY occurred_at",
    );
    expect(timeline.at(-1)?.subject).toContain("Email not sent");

    await ownerQuery("UPDATE email_messages SET to_email = 'dana@harbor.example'");
    const retry = await app.inject({ method: "POST", url: `/api/emails/${failed?.id ?? ""}/retry`, ...as() });
    expect(retry.statusCode).toBe(202);
    await sendJobs();
    expect(mailbox.sent).toHaveLength(1);
    expect(await ownerQuery("SELECT id FROM email_messages")).toHaveLength(1);
  });

  it("is the only path: MailProvider.send is called from exactly one place, the mail.send job", () => {
    const root = join(__dirname, "..", "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", "dist", "test", "reference", ".git", ".claude", "e2e", "coverage"].includes(name))
          continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) files.push(path);
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    const calls = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/\.mail\.send\s*\(|\bmail\.send\s*\(|provider\.send\s*\(/g)].map(() =>
        file.slice(root.length + 1),
      ),
    );
    expect(calls).toEqual(["apps/api/src/services/mail-jobs.ts"]);
    const source = readFileSync(join(root, "apps/api/src/services/mail-jobs.ts"), "utf8");
    const at = source.search(/\bmail\.send\s*\(/);
    const enclosing = source.slice(0, at).lastIndexOf("export async function ");
    expect(source.slice(enclosing, enclosing + 40)).toContain("runMailSend");
  });
});

describe("unsubscribe, replies and bounces (§8.4)", () => {
  const sendOne = async () => {
    const draft = await createDraft();
    expect((await send(draft.id)).statusCode).toBe(202);
    await sendJobs();
    const mail = mailbox.sent.at(-1);
    if (mail === undefined) throw new Error("nothing sent");
    return mail;
  };

  it("unsubscribes with the link, and the next send to that address is refused for every rep", async () => {
    const mail = await sendOne();
    const path = /http:\/\/localhost:3000(\/u\/[\w.-]+)/.exec(mail.text)?.[1] ?? "";
    const page = await app.inject({ method: "GET", url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("dana@harbor.example");
    expect(page.body).toContain('<form method="post">');
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("script-src 'self'");
    expect(await ownerQuery("SELECT email FROM suppressions")).toHaveLength(0); // a GET changes nothing

    const confirmed = await app.inject({ method: "POST", url: path });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body).toContain("unsubscribed");
    expect(await ownerQuery("SELECT reason FROM suppressions WHERE email = 'dana@harbor.example'")).toEqual([
      { reason: "unsubscribe" },
    ]);

    const other = await createUser("lee@soa.example");
    const otherSession = await signIn(app, other.email);
    const theirs = await arrange("DANA@harbor.example", other.id, "Other Park");
    const draft = await createDraft({}, otherSession, theirs.accountId, theirs.contactId);
    expect((await send(draft.id, otherSession)).statusCode).toBe(422);
  });

  it("rejects a changed unsubscribe token", async () => {
    const mail = await sendOne();
    const path = /http:\/\/localhost:3000(\/u\/[\w.-]+)/.exec(mail.text)?.[1] ?? "";
    const forged = `/u/${Buffer.from("someone@else.example").toString("base64url")}.${path.split(".")[1] ?? ""}`;
    expect((await app.inject({ method: "POST", url: forged })).statusCode).toBe(404);
    expect(await ownerQuery("SELECT email FROM suppressions")).toHaveLength(0);
  });

  it("stores a reply on the thread with a classification; a reply on an unrelated thread is not stored anywhere", async () => {
    const mail = await sendOne();
    const [thread] = await ownerQuery<{ provider_thread_id: string }>("SELECT provider_thread_id FROM email_messages");
    mailbox.inbox.push(
      {
        providerMessageId: "<reply-1@harbor.example>",
        providerThreadId: thread?.provider_thread_id ?? "",
        fromEmail: "dana@harbor.example",
        toEmail: mail.from.email,
        subject: `Re: ${mail.subject}`,
        text: "Sounds good, let's talk Tuesday.",
        receivedAt: new Date(),
        bounce: false,
      },
      {
        providerMessageId: "<private@elsewhere.example>",
        providerThreadId: "some-other-thread",
        fromEmail: "friend@elsewhere.example",
        toEmail: mail.from.email,
        subject: "Lunch?",
        text: "Unrelated private mail about lunch.",
        receivedAt: new Date(),
        bounce: false,
      },
    );
    adapter.calls.length = 0;
    const worker = await runWorker();
    await worker.sync(ae.id);
    await worker.sync(ae.id); // a second sync stores nothing twice
    await worker.close();

    const inbound = await ownerQuery<{ subject: string; ai_classification: string }>(
      "SELECT subject, ai_classification FROM email_messages WHERE direction = 'in'",
    );
    expect(inbound).toEqual([{ subject: `Re: ${mail.subject}`, ai_classification: "interested" }]);
    const everything = JSON.stringify([
      await ownerQuery("SELECT * FROM email_messages"),
      await ownerQuery("SELECT * FROM activities"),
      await ownerQuery("SELECT * FROM ai_calls"),
      await ownerQuery("SELECT * FROM tasks"),
    ]);
    expect(everything).not.toContain("Unrelated private mail");
    expect(everything).not.toContain("friend@elsewhere.example");
    expect(adapter.calls.map((call) => call.feature)).toEqual(["reply_classify"]);
    const [activity] = await ownerQuery<{ meta: { classification: string } }>(
      "SELECT meta FROM activities WHERE type = 'email_in'",
    );
    expect(activity?.meta.classification).toBe("interested");
    expect(await ownerQuery("SELECT title FROM tasks")).toEqual([{ title: "Reply to Dana Whitfield" }]);
  });

  it("treats a reply asking to unsubscribe like the link, and tells the rep", async () => {
    const mail = await sendOne();
    const [thread] = await ownerQuery<{ provider_thread_id: string }>("SELECT provider_thread_id FROM email_messages");
    mailbox.inbox.push({
      providerMessageId: "<reply-2@harbor.example>",
      providerThreadId: thread?.provider_thread_id ?? "",
      fromEmail: "dana@harbor.example",
      toEmail: mail.from.email,
      subject: "Re: hello",
      text: "Please remove me from your list.",
      receivedAt: new Date(),
      bounce: false,
    });
    const worker = await runWorker();
    await worker.sync(ae.id);
    await worker.close();
    expect(await ownerQuery("SELECT reason FROM suppressions")).toEqual([{ reason: "unsubscribe" }]);
    expect(await ownerQuery("SELECT email_status FROM contacts")).toEqual([{ email_status: "unsubscribed" }]);
    const notes = await ownerQuery<{ subject: string }>("SELECT subject FROM activities WHERE type = 'note'");
    expect(notes.map((row) => row.subject).join(" ")).toContain("asking to unsubscribe");
  });

  it("marks the contact bounced and suppresses the address on a bounce", async () => {
    const mail = await sendOne();
    const [thread] = await ownerQuery<{ provider_thread_id: string }>("SELECT provider_thread_id FROM email_messages");
    mailbox.inbox.push({
      providerMessageId: "<ndr@soa.example>",
      providerThreadId: thread?.provider_thread_id ?? "",
      fromEmail: "postmaster@soa.example",
      toEmail: mail.from.email,
      subject: "Undeliverable: hello",
      text: "Delivery has failed to these recipients.",
      receivedAt: new Date(),
      bounce: true,
    });
    const worker = await runWorker();
    await worker.sync(ae.id);
    await worker.close();
    expect(await ownerQuery("SELECT status FROM email_messages")).toEqual([{ status: "bounced" }]);
    expect(await ownerQuery("SELECT email_status FROM contacts")).toEqual([{ email_status: "bounced" }]);
    expect(await ownerQuery("SELECT email, reason FROM suppressions")).toEqual([
      { email: "dana@harbor.example", reason: "bounce" },
    ]);
  });

  it("with an expired refresh token: reconnect banner, the send fails once, and nothing retries", async () => {
    await ownerQuery("UPDATE oauth_accounts SET expires_at = now() - interval '1 hour'");
    mailbox.state.failRefresh = true;
    const draft = await createDraft();
    expect((await send(draft.id)).statusCode).toBe(202);
    await sendJobs();
    expect(mailbox.sent).toHaveLength(0);
    const [message] = await ownerQuery<{ status: string; error: string }>("SELECT status, error FROM email_messages");
    expect(message?.status).toBe("failed");
    expect(message?.error).toContain("Reconnect");

    const me = (await app.inject({ method: "GET", url: "/api/me", ...as() })).json<{
      mail: { needsReconnect: boolean };
    }>();
    expect(me.mail.needsReconnect).toBe(true);

    const worker = await runWorker();
    expect(await worker.syncable()).toEqual([]); // no more sync jobs for this user
    await worker.sync(ae.id);
    await worker.close();
    expect(mailbox.state.refreshes).toBe(1); // tried once, never again

    const again = await createDraft();
    expect((await send(again.id)).statusCode).toBe(409);

    // Signing in again reconnects.
    session = await signIn(app, ae.email);
    const meAfter = (await app.inject({ method: "GET", url: "/api/me", ...as() })).json<{
      mail: { needsReconnect: boolean };
    }>();
    expect(meAfter.mail.needsReconnect).toBe(false);
  });
});

describe("suppressions admin", () => {
  it("lets a manager add and remove an address, audited; reps can only read", async () => {
    const manager = await createUser("max@soa.example", "manager");
    const managerSession = await signIn(app, manager.email);
    const add = (who: SignedIn) =>
      app.inject({
        method: "POST",
        url: "/api/suppressions",
        ...as(who),
        payload: { email: "Opt.Out@Example.example" },
      });
    expect((await add(session)).statusCode).toBe(403);
    expect((await add(managerSession)).statusCode).toBe(201);
    expect((await add(managerSession)).statusCode).toBe(409);
    const list = (await app.inject({ method: "GET", url: "/api/suppressions", ...as() })).json<{
      items: { email: string }[];
    }>();
    expect(list.items.map((item) => item.email)).toEqual(["opt.out@example.example"]);
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/suppressions/opt.out@example.example",
      ...as(managerSession),
    });
    expect(removed.statusCode).toBe(204);
    const audit = await ownerQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE action LIKE 'suppression.%'",
    );
    expect(audit.map((row) => row.action).sort()).toEqual(["suppression.add", "suppression.remove"]);
  });
});
