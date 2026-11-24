import type { Database } from "@soa/db";
import type { TokenCipher } from "../auth/crypto";
import type { Clock } from "../clock";
import { MailAuthError, type MailTokens } from "../providers/mail/types";
import { mailAccountsRepo } from "../repos/outreach";
import { systemScope } from "../repos/scope";

/* The rep's Microsoft 365 tokens (mail and calendar share one consent, §15). Tokens never leave the server. */

export interface TokenRefresher {
  refresh: (refreshToken: string) => Promise<MailTokens>;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A usable access token for the user, refreshed when close to expiry. "reconnect" when the rep must sign in again:
    needs_reconnect is set and nothing retries until they do (§8.4). */
export async function accessTokenFor(
  deps: { db: Database; refresher: TokenRefresher; cipher: TokenCipher; clock: Clock },
  userId: string,
): Promise<{ accessToken: string; provider: "microsoft" | "google" } | "reconnect"> {
  const scope = systemScope("mail token");
  const repo = mailAccountsRepo(deps.db);
  const row = await repo.get(scope, userId);
  if (row === undefined || row.account.needsReconnect || !row.user.active) return "reconnect";
  const { account } = row;
  if (account.expiresAt.getTime() - deps.clock().getTime() > REFRESH_MARGIN_MS) {
    return { accessToken: deps.cipher.decrypt(account.accessTokenEnc), provider: account.provider };
  }
  try {
    const tokens = await deps.refresher.refresh(deps.cipher.decrypt(account.refreshTokenEnc));
    await repo.update(scope, userId, account.provider, {
      accessTokenEnc: deps.cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: deps.cipher.encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
    });
    return { accessToken: tokens.accessToken, provider: account.provider };
  } catch (error) {
    if (!(error instanceof MailAuthError)) throw error; // network trouble: try again later
    await repo.update(scope, userId, account.provider, { needsReconnect: true });
    return "reconnect";
  }
}
