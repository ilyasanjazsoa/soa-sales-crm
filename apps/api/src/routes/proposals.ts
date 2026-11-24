import { createHash } from "node:crypto";
import {
  CreateContractRequest,
  CreateProposalRequest,
  IdParam,
  PricingConfigInput,
  ProposalPatch,
  QuoteRequest,
} from "@soa/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/plugin";
import type { Clock } from "../clock";
import { rateLimited, RateLimiter, SECURITY_HEADERS } from "../security";
import type { ProposalsService } from "../services/proposals";

const session = { config: { access: "session" } } as const;
const manager = { config: { access: "manager" } } as const;
const publicRoute = { config: { access: "public" } } as const;

const pdf = (reply: FastifyReply, body: Buffer, filename: string) =>
  reply
    .header("content-type", "application/pdf")
    .header("content-disposition", `inline; filename="${filename}"`)
    .header("cache-control", "private, no-store")
    .send(body);

export function registerProposalRoutes(
  app: FastifyInstance,
  deps: {
    proposals: ProposalsService;
    fakeSign?: (contractId: string, event: "viewed" | "signed" | "declined") => Promise<string>;
  },
): void {
  const { proposals } = deps;
  const id = (params: unknown) => IdParam.parse(params).id;

  // ───────── pricing ─────────
  app.post("/api/pricing/quote", session, async (request) =>
    proposals.quote(sessionOf(request).scope, QuoteRequest.parse(request.body)),
  );
  app.get("/api/pricing/config", session, async (request) => proposals.pricingConfig(sessionOf(request).scope));
  app.post("/api/pricing/config", manager, async (request, reply) =>
    reply
      .code(201)
      .send(
        await proposals.createPricingConfig(
          sessionOf(request).scope,
          PricingConfigInput.parse(request.body),
          request.ip,
        ),
      ),
  );

  // ───────── proposals ─────────
  app.get("/api/deals/:id/proposals", session, async (request) => ({
    items: await proposals.list(sessionOf(request).scope, id(request.params)),
  }));
  app.post("/api/deals/:id/proposals", session, async (request, reply) =>
    reply
      .code(201)
      .send(
        await proposals.create(
          sessionOf(request).scope,
          id(request.params),
          CreateProposalRequest.parse(request.body),
          request.ip,
        ),
      ),
  );
  app.get("/api/proposals/:id", session, async (request) =>
    proposals.get(sessionOf(request).scope, id(request.params)),
  );
  app.patch("/api/proposals/:id", session, async (request) =>
    proposals.update(sessionOf(request).scope, id(request.params), ProposalPatch.parse(request.body), request.ip),
  );
  app.post("/api/proposals/:id/approve-discount", manager, async (request) =>
    proposals.approveDiscount(sessionOf(request).scope, id(request.params), request.ip),
  );
  app.post("/api/proposals/:id/render", session, async (request, reply) => {
    await proposals.render(sessionOf(request).scope, id(request.params));
    return reply.code(202).send({ status: "queued" });
  });
  app.post("/api/proposals/:id/send", session, async (request) => {
    const body = z
      .object({ contactId: z.uuid().optional() })
      .strict()
      .parse(request.body ?? {});
    return proposals.send(sessionOf(request).scope, id(request.params), body.contactId, request.ip);
  });
  app.get("/api/proposals/:id/pdf", session, async (request, reply) =>
    pdf(reply, await proposals.pdf(sessionOf(request).scope, id(request.params)), "proposal.pdf"),
  );

  // ───────── contracts ─────────
  app.post("/api/proposals/:id/contract", session, async (request, reply) =>
    reply
      .code(201)
      .send(
        await proposals.createContract(
          sessionOf(request).scope,
          id(request.params),
          CreateContractRequest.parse(request.body),
          request.ip,
        ),
      ),
  );
  app.get("/api/deals/:id/contracts", session, async (request) => ({
    items: await proposals.contracts(sessionOf(request).scope, id(request.params)),
  }));
  app.get("/api/contracts/:id", session, async (request) =>
    proposals.contract(sessionOf(request).scope, id(request.params)),
  );
  app.get("/api/contracts/:id/signed.pdf", session, async (request, reply) =>
    pdf(reply, await proposals.signedPdf(sessionOf(request).scope, id(request.params)), "signed-agreement.pdf"),
  );
  app.post("/api/contracts/:id/void", session, async (request) =>
    proposals.voidContract(sessionOf(request).scope, id(request.params), request.ip),
  );

  // FAKE_PROVIDERS only: play the e-signature provider's part, through the real webhook code.
  const fakeSign = deps.fakeSign;
  if (fakeSign !== undefined) {
    app.post("/api/contracts/:id/fake-sign", session, async (request) => {
      const contractId = id(request.params);
      await proposals.contract(sessionOf(request).scope, contractId); // must be visible to the caller
      const body = z.object({ event: z.enum(["viewed", "signed", "declined"]) }).parse(request.body);
      const json = await fakeSign(contractId, body.event);
      return { result: await proposals.webhook(json) };
    });
  }
}

// ───────── public surface (§10.3) ─────────

const STYLE =
  "html,body{height:100%;margin:0}body{font-family:system-ui,sans-serif;background:#18181b;color:#e4e4e7;display:flex;flex-direction:column}" +
  "header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #3f3f46}" +
  "h1{font-size:16px;margin:0;flex:1}a{color:#6ee7b7}iframe{flex:1;border:0;width:100%;background:#fff}" +
  "main{max-width:420px;margin:48px auto;padding:0 16px}p{color:#a1a1aa;line-height:1.5}";
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");
const BASE_CSP = SECURITY_HEADERS["content-security-policy"] ?? "default-src 'none'";
const PAGE_CSP = `${BASE_CSP.replace("style-src 'self'", `style-src 'sha256-${STYLE_HASH}'`)}; frame-src 'self'`;
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
const page = (reply: FastifyReply, status: number, title: string, body: string) =>
  reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", PAGE_CSP)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-robots-tag", "noindex")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    );

const TokenParam = z.object({ token: z.string().min(20).max(100) });

export function registerPublicProposalRoutes(
  app: FastifyInstance,
  deps: { proposals: ProposalsService; companyName: string; clock: Clock },
): void {
  const { proposals } = deps;
  const viewLimiter = new RateLimiter(30, deps.clock); // 30 a minute per address (§10.3)
  const hookLimiter = new RateLimiter(30, deps.clock);
  const notFoundPage = (reply: FastifyReply) =>
    page(
      reply,
      404,
      "This link isn't valid",
      "<main><h1>This link isn't valid</h1><p>It may have expired. Ask your contact for a new one.</p></main>",
    );

  app.get("/p/:token", publicRoute, async (request, reply) => {
    if (!viewLimiter.hit(`p:${request.ip}`)) throw rateLimited();
    const parsed = TokenParam.safeParse(request.params);
    const found = parsed.success ? await proposals.byToken(parsed.data.token) : undefined;
    if (!parsed.success || found === undefined) return notFoundPage(reply);
    const { row, rep } = found;
    const format = z.object({ format: z.literal("pdf").optional() }).safeParse(request.query);
    if (format.success && format.data.format === "pdf") {
      // The PDF itself, framed only by this page.
      const body = await proposals.readPdf(row.proposal.pdfObjectKey ?? "");
      return (
        reply
          .header("content-type", "application/pdf")
          .header("content-disposition", 'inline; filename="proposal.pdf"')
          .header("cache-control", "no-store")
          // Only this page may frame it. No default-src: that would also block the browser's PDF viewer.
          .header("content-security-policy", "frame-ancestors 'self'")
          .header("x-frame-options", "SAMEORIGIN")
          .send(body)
      );
    }
    await proposals.recordView(
      row.proposal.id,
      row.accountId,
      row.proposal.dealId,
      request.ip,
      request.headers["user-agent"],
    );
    const contact =
      rep === undefined
        ? ""
        : `<a href="mailto:${escapeHtml(rep.email)}?subject=${encodeURIComponent(`Proposal for ${row.accountName}`)}">Contact ${escapeHtml(rep.name)}</a>`;
    return page(
      reply,
      200,
      `Proposal for ${row.accountName}`,
      `<header><h1>${escapeHtml(deps.companyName)}: proposal for ${escapeHtml(row.accountName)}</h1>${contact}<a href="?format=pdf" download="proposal.pdf">Download PDF</a></header><iframe src="?format=pdf" title="Proposal"></iframe>`,
    );
  });

  /** Dropbox Sign callbacks: multipart/form-data with a `json` field. */
  app.post("/webhooks/esign", publicRoute, async (request, reply) => {
    if (!hookLimiter.hit(`w:${request.ip}`)) throw rateLimited();
    let json: string | undefined;
    if (request.isMultipart()) {
      for await (const part of request.parts({ limits: { fields: 10, files: 0, fieldSize: 1024 * 1024 } })) {
        if (part.type === "field" && part.fieldname === "json" && typeof part.value === "string") json = part.value;
      }
    } else {
      const body = z.object({ json: z.string() }).safeParse(request.body);
      if (body.success) json = body.data.json;
    }
    if (json === undefined || (await proposals.webhook(json)) === "rejected") {
      return reply.code(401).send({ error: { code: "bad_signature", message: "Signature check failed." } });
    }
    return reply.header("content-type", "text/plain").send("Hello API Event Received");
  });
}
