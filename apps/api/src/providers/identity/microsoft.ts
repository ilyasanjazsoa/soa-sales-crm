import * as oidc from "openid-client";
import type { Clock } from "../../clock";
import { MICROSOFT_SCOPES, type IdentityProvider } from "./types";

export interface MicrosoftOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  clock: Clock;
}

/** Microsoft Entra ID through openid-client (discovery, PKCE, ID token validation, nonce and state checks). */
export function createMicrosoftIdentityProvider(options: MicrosoftOptions): IdentityProvider {
  let configuration: Promise<oidc.Configuration> | undefined;
  const config = () => {
    configuration ??= oidc
      .discovery(
        new URL(`https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/v2.0`),
        options.clientId,
        options.clientSecret,
      )
      .catch((error: unknown) => {
        configuration = undefined; // retry discovery on the next sign-in
        throw error;
      });
    return configuration;
  };

  return {
    provider: "microsoft",

    async authorizationUrl(request) {
      return oidc
        .buildAuthorizationUrl(await config(), {
          redirect_uri: request.redirectUri,
          scope: MICROSOFT_SCOPES.join(" "),
          code_challenge: request.codeChallenge,
          code_challenge_method: "S256",
          state: request.state,
          nonce: request.nonce,
          prompt: "select_account",
        })
        .toString();
    },

    async exchangeCode(exchange) {
      const callback = new URL(exchange.callbackUrl.toString());
      callback.search = "";
      if (callback.toString() !== exchange.redirectUri) throw new Error("callback URL does not match the redirect URI");
      const tokens = await oidc.authorizationCodeGrant(await config(), exchange.callbackUrl, {
        pkceCodeVerifier: exchange.codeVerifier,
        expectedState: exchange.state,
        expectedNonce: exchange.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (claims === undefined) throw new Error("ID token missing");
      // The UPN (preferred_username) is the tenant's sign-in name. The `email` claim is optional and editable,
      // so it is only a fallback; the user is bound to the immutable `oid` after the first sign-in (services/auth.ts).
      const email = [claims.preferred_username, claims.email].find(
        (value): value is string => typeof value === "string" && value.includes("@"),
      );
      const subject = typeof claims.oid === "string" ? claims.oid : claims.sub;
      if (email === undefined) throw new Error("ID token has no email");
      if (tokens.refresh_token === undefined) throw new Error("No refresh token (offline_access not granted)");
      return {
        subject,
        email: email.toLowerCase(),
        name: typeof claims.name === "string" ? claims.name : email,
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: new Date(options.clock().getTime() + (tokens.expiresIn() ?? 3600) * 1000),
          scopes: (tokens.scope ?? MICROSOFT_SCOPES.join(" ")).split(" ").filter(Boolean),
        },
      };
    },
  };
}
