import { createHash } from "node:crypto";
import { AddSuppressionRequest, CreateDraftRequest, DraftPatch, IdParam, LogOutcomeRequest } from "@soa/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/plugin";
import type { Clock } from "../clock";
import { rateLimited, RateLimiter, SECURITY_HEADERS } from "../security";
import type { createUnsubscribeService, OutreachService } from "../services/outreach";

const session = { config: { access: "session" } } as const;
const manager = { config: { access: "manager" } } as const;
const publicRoute = { config: { access: "public" } } as const;

export function registerOutreachRoutes(app: FastifyInstance, deps: { outreach: OutreachService }): void {
  const { outreach } = deps;
  const id = (params: unknown) => IdParam.parse(params).id;

  app.get("/api/accounts/:id/drafts", session, async (request) =>
    outreach.listDrafts(sessionOf(request).scope, id(request.params)),
  );
  app.post("/api/accounts/:id/drafts", session, async (request, reply) =>
    reply
      .code(201)
      .send(
        await outreach.createDraft(
          sessionOf(request).scope,
          id(request.params),
          CreateDraftRequest.parse(request.body),
        ),
      ),
  );
  app.get("/api/drafts/:id", session, async (request) =>
    outreach.getDraft(sessionOf(request).scope, id(request.params)),
  );
  app.patch("/api/drafts/:id", session, async (request) =>
    outreach.updateDraft(sessionOf(request).scope, id(request.params), DraftPatch.parse(request.body)),
  );
  app.post("/api/drafts/:id/regenerate", session, async (request) =>
    outreach.regenerate(sessionOf(request).scope, id(request.params)),
  );
  // The single send path (ARCHITECTURE.md §8.2, CLAUDE.md rule 2).
  app.post("/api/drafts/:id/send", session, async (request, reply) =>
    reply.code(202).send(await outreach.send(sessionOf(request).scope, id(request.params), request.ip)),
  );
  app.post("/api/drafts/:id/log", session, async (request) =>
    outreach.log(sessionOf(request).scope, id(request.params), LogOutcomeRequest.parse(request.body), request.ip),
  );
  app.delete("/api/drafts/:id", session, async (request, reply) => {
    await outreach.discard(sessionOf(request).scope, id(request.params));
    return reply.code(204).send();
  });

  app.get("/api/accounts/:id/emails", session, async (request) => ({
    items: await outreach.emails(sessionOf(request).scope, id(request.params)),
  }));
  app.post("/api/emails/:id/retry", session, async (request, reply) => {
    await outreach.retry(sessionOf(request).scope, id(request.params), request.ip);
    return reply.code(202).send({ status: "queued" });
  });

  app.get("/api/suppressions", session, async (request) => ({
    items: await outreach.suppressions(sessionOf(request).scope),
  }));
  app.post("/api/suppressions", manager, async (request, reply) => {
    await outreach.addSuppression(sessionOf(request).scope, AddSuppressionRequest.parse(request.body), request.ip);
    return reply.code(201).send({ ok: true });
  });
  app.delete("/api/suppressions/:email", manager, async (request, reply) => {
    const { email } = z.object({ email: z.email().toLowerCase() }).parse(request.params);
    await outreach.removeSuppression(sessionOf(request).scope, email, request.ip);
    return reply.code(204).send();
  });
}

// ───────── public unsubscribe pages (§8.4, §10.3) ─────────

const STYLE =
  "body{font-family:system-ui,sans-serif;background:#18181b;color:#e4e4e7;display:flex;justify-content:center;padding:48px 16px;margin:0}" +
  "main{max-width:420px;background:#27272a;border:1px solid #3f3f46;border-radius:12px;padding:24px}" +
  "h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#a1a1aa}" +
  "button{background:#059669;color:white;border:0;border-radius:8px;padding:10px 16px;font-size:15px;cursor:pointer}";
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");
const PAGE_CSP = SECURITY_HEADERS["content-security-policy"]?.replace(
  "style-src 'self'",
  `style-src 'sha256-${STYLE_HASH}'`,
);

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

function page(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", PAGE_CSP ?? "")
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    );
}

const TokenParam = z.object({ token: z.string().min(10).max(600) });

export function registerUnsubscribeRoutes(
  app: FastifyInstance,
  deps: { unsubscribe: ReturnType<typeof createUnsubscribeService>; companyName: string; clock: Clock },
): void {
  const { unsubscribe, companyName } = deps;
  const limiter = new RateLimiter(30, deps.clock); // 30 a minute per address (§10.3)
  const invalid = (reply: FastifyReply) =>
    page(reply, 404, "This link isn't valid", "<p>The unsubscribe link is incomplete or has been changed.</p>");

  app.get("/u/:token", publicRoute, async (request, reply) => {
    if (!limiter.hit(`u:${request.ip}`)) throw rateLimited();
    const parsed = TokenParam.safeParse(request.params);
    const email = parsed.success ? unsubscribe.read(parsed.data.token) : undefined;
    if (!parsed.success || email === undefined) return invalid(reply);
    // A GET never changes anything (mail scanners follow links); the button posts to the same address.
    return page(
      reply,
      200,
      `Unsubscribe from ${companyName}`,
      `<p>Stop sales email from ${escapeHtml(companyName)} to <strong>${escapeHtml(email)}</strong>?</p><form method="post"><button type="submit">Unsubscribe</button></form>`,
    );
  });

  // Also the List-Unsubscribe one-click target (RFC 8058).
  app.post("/u/:token", publicRoute, async (request, reply) => {
    if (!limiter.hit(`u:${request.ip}`)) throw rateLimited();
    const parsed = TokenParam.safeParse(request.params);
    if (!parsed.success || !(await unsubscribe.confirm(parsed.data.token))) return invalid(reply);
    return page(
      reply,
      200,
      "You're unsubscribed",
      `<p>You won't get sales email from ${escapeHtml(companyName)} again. It can take a moment for anything already on its way.</p>`,
    );
  });
}
