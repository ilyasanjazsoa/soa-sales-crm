import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../../clock";
import { MailAuthError, type MailTokens } from "../mail/types";
import { MICROSOFT_SCOPES } from "./types";

/* Refreshing the rep's Microsoft 365 access token (shared by mail and calendar). A refresh the provider refuses
   (expired or revoked consent) is a MailAuthError: only the rep can fix it, by signing in again. */

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
});

export function createMicrosoftTokenRefresher(options: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  clock: Clock;
  fetch?: typeof fetch;
}) {
  const http = options.fetch ?? fetch;
  return {
    async refresh(refreshToken: string): Promise<MailTokens> {
      const response = await http(
        `https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`,
        {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: MICROSOFT_SCOPES.join(" "),
          }).toString(),
        },
      );
      if (response.status === 400 || response.status === 401) throw new MailAuthError();
      if (!response.ok) throw new Error(`Token refresh failed (${String(response.status)})`);
      const tokens = TokenResponse.parse(await response.json());
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? refreshToken,
        expiresAt: new Date(options.clock().getTime() + tokens.expires_in * 1000),
      };
    },
  };
}

/** FAKE_PROVIDERS: the fake sign-in issues "fake-refresh-…" tokens; anything else fails like a revoked consent. */
export function createFakeTokenRefresher(clock: Clock = () => new Date()) {
  return {
    refresh(refreshToken: string): Promise<MailTokens> {
      if (!refreshToken.startsWith("fake-refresh-")) return Promise.reject(new MailAuthError());
      return Promise.resolve({
        accessToken: `fake-access-${randomUUID()}`,
        refreshToken,
        expiresAt: new Date(clock().getTime() + 3600_000),
      });
    },
  };
}
