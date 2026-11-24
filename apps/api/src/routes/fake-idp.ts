import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors";
import { FAKE_IDP_PATH, type FakeIdentityProvider } from "../providers/identity/fake";
import { systemScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import type { Database } from "@soa/db";

/* The fake identity provider's sign-in page. Registered only when FAKE_PROVIDERS=true, which the config
   refuses in production. Plain HTML with no scripts or inline styles, so it passes the strict CSP. */

const Params = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  code_challenge: z.string().min(1),
  redirect_uri: z.string().min(1),
});

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);

const nameFromEmail = (email: string) =>
  (email.split("@")[0] ?? email)
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export function registerFakeIdpRoutes(
  app: FastifyInstance,
  deps: { db: Database; idp: FakeIdentityProvider; redirectUri: string },
): void {
  const { db, idp, redirectUri } = deps;

  app.get(FAKE_IDP_PATH, { config: { access: "public" } }, async (request, reply) => {
    const params = Params.parse(request.query);
    if (params.redirect_uri !== redirectUri) throw badRequest("Unknown redirect URI.");
    const users = await usersRepo(db).listActive(systemScope("fake sign-in page"));
    const hidden = Object.entries(params)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
      .join("");
    const options = users
      .map((user) => `<option value="${escapeHtml(user.email)}">${escapeHtml(`${user.name} (${user.role})`)}</option>`)
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake sign-in</title></head><body>
<h1>Fake identity provider</h1>
<p>Local development only. Choose who to sign in as. Nothing here talks to Microsoft.</p>
<form method="post" action="${FAKE_IDP_PATH}">${hidden}
<p><label>Existing user <select name="email">${options}</select></label></p>
<p><label>Or another address <input type="email" name="other_email" placeholder="someone@example.com"></label></p>
<p><button type="submit">Sign in</button></p>
</form></body></html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post(FAKE_IDP_PATH, { config: { access: "public" } }, async (request, reply) => {
    const body = Params.extend({ email: z.string().optional(), other_email: z.string().optional() }).parse(
      request.body,
    );
    if (body.redirect_uri !== redirectUri) throw badRequest("Unknown redirect URI.");
    const other = body.other_email?.trim() ?? "";
    const email = (other === "" ? (body.email ?? "") : other).toLowerCase();
    if (!z.email().safeParse(email).success) throw badRequest("Enter an email address.");
    const code = idp.issueCode({
      email,
      name: nameFromEmail(email),
      nonce: body.nonce,
      challenge: body.code_challenge,
      redirectUri: body.redirect_uri,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", body.state);
    return reply.redirect(target.toString());
  });
}
