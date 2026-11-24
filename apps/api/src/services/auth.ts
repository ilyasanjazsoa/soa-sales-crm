import type { Database } from "@soa/db";
import type { Env, Role } from "@soa/shared";
import { z } from "zod";
import { hmac, randomToken, sha256Base64Url, sha256Hex, sign, verify, type TokenCipher } from "../auth/crypto";
import type { Clock } from "../clock";
import type { IdentityProvider } from "../providers/identity/types";
import { auditRepo } from "../repos/audit";
import { authRepo } from "../repos/auth";
import { systemScope, userScope, type UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";

/* Sign-in, sessions and CSRF (ARCHITECTURE.md §15). */

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_STATE_MS = 10 * 60 * 1000;
const TOUCH_AFTER_MS = 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface ResolvedSession {
  user: SessionUser;
  scope: UserScope;
  idHash: string;
}

export type LoginRefusal = "invalid_state" | "provider_error" | "domain" | "unknown_user" | "inactive";

export type LoginResult =
  { ok: true; sessionToken: string; csrfToken: string; userId: string } | { ok: false; reason: LoginRefusal };

const LoginState = z.object({ state: z.string(), verifier: z.string(), nonce: z.string(), exp: z.number() });

export interface AuthServiceDeps {
  db: Database;
  config: Env;
  clock: Clock;
  identity: IdentityProvider;
  cipher: TokenCipher;
}

export type AuthService = ReturnType<typeof createAuthService>;

export function createAuthService({ db, config, clock, identity, cipher }: AuthServiceDeps) {
  const redirectUri = new URL("/api/auth/callback", config.APP_URL).toString();
  const stateKey = `login-state:${config.SESSION_SECRET}`;
  const csrfKey = `csrf:${config.SESSION_SECRET}`;
  const system = systemScope("auth");

  const refuse = async (
    reason: LoginRefusal,
    meta: Record<string, unknown>,
    ip: string | null,
  ): Promise<LoginResult> => {
    await auditRepo(db).write(system, { action: "auth.refused", meta: { reason, ...meta }, ip });
    return { ok: false, reason };
  };

  return {
    redirectUri,

    csrfFor(idHash: string): string {
      return hmac(csrfKey, idHash);
    },

    /** Starts the authorization code flow. The state cookie carries state, PKCE verifier and nonce, signed. */
    async beginLogin(): Promise<{ url: string; stateCookie: string }> {
      const state = randomToken();
      const verifier = randomToken();
      const nonce = randomToken();
      const url = await identity.authorizationUrl({
        state,
        nonce,
        codeChallenge: sha256Base64Url(verifier),
        redirectUri,
      });
      const stateCookie = sign(stateKey, { state, verifier, nonce, exp: clock().getTime() + LOGIN_STATE_MS });
      return { url, stateCookie };
    },

    async completeLogin(input: {
      callbackUrl: URL;
      stateCookie: string | undefined;
      ip: string | null;
      userAgent: string | null;
    }): Promise<LoginResult> {
      const saved = LoginState.safeParse(
        input.stateCookie === undefined ? undefined : verify(stateKey, input.stateCookie),
      );
      const returnedState = input.callbackUrl.searchParams.get("state");
      if (!saved.success || saved.data.exp < clock().getTime() || saved.data.state !== returnedState) {
        return refuse("invalid_state", {}, input.ip);
      }

      let identityResult;
      try {
        identityResult = await identity.exchangeCode({
          callbackUrl: input.callbackUrl,
          codeVerifier: saved.data.verifier,
          state: saved.data.state,
          nonce: saved.data.nonce,
          redirectUri,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        return refuse("provider_error", { error: message.slice(0, 200) }, input.ip);
      }

      const email = identityResult.email.toLowerCase();
      if (!email.endsWith(`@${config.ALLOWED_EMAIL_DOMAIN}`)) return refuse("domain", { email }, input.ip);

      return db.transaction(async (tx): Promise<LoginResult> => {
        const users = usersRepo(tx);
        let user = await users.findByEmail(system, email);
        if (user === undefined && email === config.BOOTSTRAP_ADMIN_EMAIL) {
          const created = await users.insertIfAbsent(system, {
            email,
            name: identityResult.name,
            role: "admin",
            title: "Administrator",
          });
          if (created !== undefined) {
            await auditRepo(tx).write(system, {
              action: "user.create",
              entityType: "user",
              entityId: created.id,
              meta: { bootstrap: true, role: "admin" },
              ip: input.ip,
            });
          }
          user = created ?? (await users.findByEmail(system, email));
        }
        if (user === undefined) return refuse("unknown_user", { email }, input.ip);
        if (!user.active) return refuse("inactive", { email }, input.ip);

        const now = clock();
        const sessionToken = randomToken(32);
        const idHash = sha256Hex(sessionToken);
        const repo = authRepo(tx);
        await repo.upsertOAuthAccount(system, {
          userId: user.id,
          provider: identity.provider,
          subject: identityResult.subject,
          scopes: identityResult.tokens.scopes,
          accessTokenEnc: cipher.encrypt(identityResult.tokens.accessToken),
          refreshTokenEnc: cipher.encrypt(identityResult.tokens.refreshToken),
          expiresAt: identityResult.tokens.expiresAt,
        });
        await repo.insertSession(system, {
          idHash,
          userId: user.id,
          now,
          expiresAt: new Date(now.getTime() + SESSION_MAX_MS),
          ip: input.ip,
          userAgent: input.userAgent?.slice(0, 300) ?? null,
        });
        await auditRepo(tx).write(system, {
          action: "auth.login",
          entityType: "user",
          entityId: user.id,
          userId: user.id,
          ip: input.ip,
        });
        return { ok: true, sessionToken, csrfToken: hmac(csrfKey, idHash), userId: user.id };
      });
    },

    /** The session for a cookie value, or undefined if it is unknown, expired, idle too long, or the user is inactive. */
    async resolveSession(token: string): Promise<ResolvedSession | undefined> {
      const idHash = sha256Hex(token);
      const repo = authRepo(db);
      const session = await repo.findSession(system, idHash);
      if (session === undefined) return undefined;
      const now = clock().getTime();
      const expired = session.expiresAt.getTime() <= now || session.lastSeenAt.getTime() <= now - SESSION_IDLE_MS;
      if (expired || !session.user.active) {
        await repo.deleteSession(system, idHash);
        return undefined;
      }
      if (now - session.lastSeenAt.getTime() > TOUCH_AFTER_MS) await repo.touchSession(system, idHash, new Date(now));
      const { user } = session;
      return {
        idHash,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        scope: userScope(user.id, user.role),
      };
    },

    async logout(session: ResolvedSession, ip: string | null): Promise<void> {
      await db.transaction(async (tx) => {
        await authRepo(tx).deleteSession(system, session.idHash);
        await auditRepo(tx).write(session.scope, {
          action: "auth.logout",
          entityType: "user",
          entityId: session.user.id,
          ip,
        });
      });
    },
  };
}
