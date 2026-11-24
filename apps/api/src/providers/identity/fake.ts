import { z } from "zod";
import { randomToken, sha256Base64Url, sign, verify } from "../../auth/crypto";
import type { Clock } from "../../clock";
import { MICROSOFT_SCOPES, type IdentityProvider } from "./types";

/* Fake identity provider for local development and CI (FAKE_PROVIDERS=true; config refuses it in production).
   The "provider" is a page served by this api at /api/auth/fake-idp where you choose who to sign in as. It issues a
   signed, short-lived code that carries the email, the PKCE challenge and the nonce, so the callback path is the
   same one the real provider uses. */

export const FAKE_IDP_PATH = "/api/auth/fake-idp";

const FakeCode = z.object({
  email: z.string(),
  name: z.string(),
  nonce: z.string(),
  challenge: z.string(),
  redirectUri: z.string(),
  exp: z.number(),
});

export interface FakeIdentityProvider extends IdentityProvider {
  /** Builds the code the fake sign-in page hands back to the callback. */
  issueCode: (input: { email: string; name: string; nonce: string; challenge: string; redirectUri: string }) => string;
}

export function createFakeIdentityProvider(options: {
  appUrl: string;
  signingKey: string;
  clock: Clock;
}): FakeIdentityProvider {
  const key = `fake-idp:${options.signingKey}`;
  return {
    provider: "microsoft",

    authorizationUrl(request) {
      const url = new URL(FAKE_IDP_PATH, options.appUrl);
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("redirect_uri", request.redirectUri);
      return Promise.resolve(url.toString());
    },

    issueCode(input) {
      return sign(key, { ...input, exp: options.clock().getTime() + 5 * 60_000 });
    },

    exchangeCode(exchange) {
      const code = exchange.callbackUrl.searchParams.get("code") ?? "";
      const parsed = FakeCode.safeParse(verify(key, code));
      if (!parsed.success) return Promise.reject(new Error("invalid code"));
      const claims = parsed.data;
      if (claims.exp < options.clock().getTime()) return Promise.reject(new Error("code expired"));
      if (claims.nonce !== exchange.nonce) return Promise.reject(new Error("nonce mismatch"));
      if (claims.redirectUri !== exchange.redirectUri) return Promise.reject(new Error("redirect mismatch"));
      if (claims.challenge !== sha256Base64Url(exchange.codeVerifier))
        return Promise.reject(new Error("PKCE mismatch"));
      return Promise.resolve({
        subject: `fake-${sha256Base64Url(claims.email.toLowerCase()).slice(0, 16)}`,
        email: claims.email.toLowerCase(),
        name: claims.name,
        tokens: {
          accessToken: `fake-access-${randomToken(24)}`,
          refreshToken: `fake-refresh-${randomToken(24)}`,
          expiresAt: new Date(options.clock().getTime() + 3600_000),
          scopes: MICROSOFT_SCOPES,
        },
      });
    },
  };
}
