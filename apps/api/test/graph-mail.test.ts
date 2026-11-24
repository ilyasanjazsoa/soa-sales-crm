import { describe, expect, it } from "vitest";
import { createGraphMailProvider, toMime } from "../src/providers/mail/graph";
import { MailAuthError, MailCursorExpired, MailPermanentError, MailRetryableError } from "../src/providers/mail/types";

/* The Microsoft Graph mail adapter against a scripted fetch (no network). */

interface Call {
  url: string;
  method: string;
  contentType: string | undefined;
  body: string | undefined;
}

function scripted(responses: (Response | Error | ((call: Call) => Response))[]) {
  const calls: Call[] = [];
  const fetch = (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      contentType: (init?.headers as Record<string, string> | undefined)?.["content-type"],
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error("unexpected call"));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === "function" ? next(call) : next);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const provider = (fetch: typeof globalThis.fetch) =>
  createGraphMailProvider({ tenantId: "t", clientId: "c", clientSecret: "s", clock: () => new Date(), fetch });
const mail = {
  from: { email: "priya@soa.example", name: "Priya Raman" },
  to: "dana@harbor.example",
  subject: "Night coverage at Harbor — quick question",
  text: "Hi Dana,\n\nA short note.\n\nUnsubscribe: https://crm.soa.example/u/abc.def",
  headers: {
    "List-Unsubscribe": "<https://crm.soa.example/u/abc.def>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
};
const created = () => json(201, { id: "AAMk1", conversationId: "conv-1", internetMessageId: "<m1@soa.example>" });

describe("Graph send", () => {
  it("creates the message from MIME with real List-Unsubscribe headers, sends it, and returns the thread", async () => {
    const { fetch, calls } = scripted([created(), new Response(null, { status: 202 })]);
    const sent = await provider(fetch).send("token", mail);
    expect(sent).toEqual({ providerMessageId: "<m1@soa.example>", providerThreadId: "conv-1" });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /v1.0/me/messages",
      "POST /v1.0/me/messages/AAMk1/send",
    ]);
    expect(calls[0]?.contentType).toBe("text/plain");
    const mime = Buffer.from(calls[0]?.body ?? "", "base64").toString("utf8");
    expect(mime).toContain("To: dana@harbor.example\r\n");
    expect(mime).toContain("List-Unsubscribe: <https://crm.soa.example/u/abc.def>\r\n");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n");
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/); // the em dash is encoded
    const body = mime.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
    expect(Buffer.from(body, "base64").toString("utf8")).toBe(mail.text.replace(/\n/g, "\r\n"));
  });

  it("strips line breaks from header values, so nothing can inject a header", () => {
    const mime = Buffer.from(
      toMime({ ...mail, to: "dana@harbor.example\r\nBcc: everyone@x.example" }),
      "base64",
    ).toString();
    expect(mime).not.toMatch(/\r\nBcc:/);
  });

  it("is retryable when creating fails (nothing was sent)", async () => {
    await expect(provider(scripted([json(503, {})]).fetch).send("token", mail)).rejects.toBeInstanceOf(
      MailRetryableError,
    );
    await expect(provider(scripted([new Error("ECONNRESET")]).fetch).send("token", mail)).rejects.toBeInstanceOf(
      MailRetryableError,
    );
  });

  it("is not retryable when /send fails or times out (delivery unknown)", async () => {
    const failed = provider(scripted([created(), json(500, {})]).fetch).send("token", mail);
    await expect(failed).rejects.not.toBeInstanceOf(MailRetryableError);
    const timedOut = provider(scripted([created(), new Error("timeout")]).fetch).send("token", mail);
    await expect(timedOut).rejects.not.toBeInstanceOf(MailRetryableError);
  });

  it("deletes the draft and retries later on 429 from /send; 401 means reconnect; 400 is permanent", async () => {
    const busy = scripted([created(), json(429, {}), new Response(null, { status: 204 })]);
    await expect(provider(busy.fetch).send("token", mail)).rejects.toBeInstanceOf(MailRetryableError);
    expect(busy.calls[2]?.method).toBe("DELETE");
    await expect(provider(scripted([json(401, {})]).fetch).send("token", mail)).rejects.toBeInstanceOf(MailAuthError);
    await expect(provider(scripted([json(400, {})]).fetch).send("token", mail)).rejects.toBeInstanceOf(
      MailPermanentError,
    );
  });
});

describe("Graph sync", () => {
  const message = (id: string, from: string, subject: string) => ({
    id,
    conversationId: "conv-1",
    internetMessageId: `<${id}@x.example>`,
    subject,
    receivedDateTime: "2026-03-02T15:00:00Z",
    from: { emailAddress: { address: from } },
    toRecipients: [{ emailAddress: { address: "priya@soa.example" } }],
    body: { content: "Sounds good." },
  });

  it("only finds the starting point on the first run, then collects new mail", async () => {
    const first = scripted([
      json(200, {
        value: [message("old", "dana@harbor.example", "Old mail")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next1",
      }),
      json(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta1" }),
    ]);
    const start = await provider(first.fetch).listNew("token", null);
    expect(start).toEqual({ messages: [], cursor: "https://graph.microsoft.com/v1.0/delta1" });

    const next = scripted([
      json(200, {
        value: [
          message("r1", "Dana@Harbor.example", "Re: Night coverage"),
          message("n1", "postmaster@soa.example", "Undeliverable: hi"),
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta2",
      }),
    ]);
    const result = await provider(next.fetch).listNew("token", start.cursor);
    expect(next.calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/delta1");
    expect(result.messages.map((entry) => [entry.fromEmail, entry.providerThreadId, entry.bounce])).toEqual([
      ["dana@harbor.example", "conv-1", false],
      ["postmaster@soa.example", "conv-1", true],
    ]);
    expect(result.cursor).toBe("https://graph.microsoft.com/v1.0/delta2");
  });

  it("keeps walking without collecting when the first run doesn't reach the end", async () => {
    const pages = Array.from({ length: 50 }, (_, index) =>
      json(200, {
        value: [message(`old${String(index)}`, "a@b.example", "Old")],
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/p${String(index + 1)}`,
      }),
    );
    const first = await provider(scripted(pages).fetch).listNew("token", null);
    expect(first.messages).toEqual([]);
    expect(first.cursor).toBe("init:https://graph.microsoft.com/v1.0/p50");
    const rest = await provider(
      scripted([
        json(200, {
          value: [message("old50", "a@b.example", "Old")],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/d",
        }),
      ]).fetch,
    ).listNew("token", first.cursor);
    expect(rest).toEqual({ messages: [], cursor: "https://graph.microsoft.com/v1.0/d" });
  });

  it("reports an expired cursor and lost permission so the job can recover", async () => {
    await expect(
      provider(scripted([json(410, {})]).fetch).listNew("token", "https://graph.microsoft.com/v1.0/d"),
    ).rejects.toBeInstanceOf(MailCursorExpired);
    await expect(
      provider(scripted([json(400, { error: { code: "syncStateNotFound" } })]).fetch).listNew(
        "token",
        "https://graph.microsoft.com/v1.0/d",
      ),
    ).rejects.toBeInstanceOf(MailCursorExpired);
    await expect(provider(scripted([json(403, {})]).fetch).listNew("token", null)).rejects.toBeInstanceOf(
      MailAuthError,
    );
  });

  it("treats a refused refresh as reconnect, and other failures as temporary", async () => {
    await expect(provider(scripted([json(400, { error: "invalid_grant" })]).fetch).refresh("r")).rejects.toBeInstanceOf(
      MailAuthError,
    );
    await expect(provider(scripted([json(503, {})]).fetch).refresh("r")).rejects.not.toBeInstanceOf(MailAuthError);
    const ok = await provider(scripted([json(200, { access_token: "a2", expires_in: 3600 })]).fetch).refresh("r");
    expect(ok.accessToken).toBe("a2");
    expect(ok.refreshToken).toBe("r");
  });
});
