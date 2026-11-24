/* Sign-in through OpenID Connect (authorization code + PKCE). One real adapter (Microsoft Entra ID,
   DECISIONS.md decision 10) and one fake for local development and CI. */

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface CodeExchange {
  /** The full callback URL the provider redirected to (contains code and state). */
  callbackUrl: URL;
  codeVerifier: string;
  state: string;
  nonce: string;
  redirectUri: string;
}

export interface IdentityResult {
  /** The provider's stable user id. */
  subject: string;
  email: string;
  name: string;
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date; scopes: string[] };
}

export interface IdentityProvider {
  readonly provider: "microsoft" | "google";
  authorizationUrl: (request: AuthorizationRequest) => Promise<string>;
  exchangeCode: (exchange: CodeExchange) => Promise<IdentityResult>;
}

/** Sign-in plus mail and calendar consent in one step (ARCHITECTURE.md §15). */
export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Send",
  "Mail.Read",
  "Calendars.ReadWrite",
];
