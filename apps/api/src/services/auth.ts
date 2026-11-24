import type { Database, Executor } from "@soa/db";
import type { Env, Role } from "@soa/shared";
import { z } from "zod";
import { hmac, randomToken, sha256Base64Url, sha256Hex, sign, verify, type TokenCipher } from "../auth/crypto";
import type { Clock } from "../clock";
import type { IdentityProvider } from "../providers/identity/types";
import { auditRepo } from "../repos/audit";
import { authRepo } from "../repos/auth";
import { systemScope, userScope, type UserScope } from "../repos/scope";
import { usersRepo, type UserRow } from "../repos/users";

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

export type LoginRefusal =
  "invalid_state" | "provider_error" | "domain" | "unknown_user" | "inactive" | "identity_mismatch";

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

/** The kind of provider failure, never its message (which can echo request data). */
const errorKind = (error: unknown): string => {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === "string" ? `${error.name}:${code}` : error.name;
  }
  return typeof error;
};

export function createAuthService({ db, config, clock, identity, cipher }: AuthServiceDeps) {
  const redirectUri = new URL("/api/auth/callback", config.APP_URL).toString();
  const stateKey = `login-state:${config.SESSION_SECRET}`;
  const csrfKey = `csrf:${config.SESSION_SECRET}`;
  const system = systemScope("auth");

  const refuse = async (
    executor: Executor,
    reason: LoginRefusal,
    meta: Record<string, unknown>,
    ip: string | null,
  ): Promise<LoginResult> => {
    await auditRepo(executor).write(system, { action: "auth.refused", meta: { reason, ...meta }, ip });
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
        return refuse(db, "invalid_state", {}, input.ip);
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
        return refuse(db, "provider_error", { error: errorKind(error) }, input.ip);
      }

      const email = identityResult.email.toLowerCase();
      if (!email.endsWith(`@${config.ALLOWED_EMAIL_DOMAIN}`)) return refuse(db, "domain", { email }, input.ip);

      return db.transaction(async (tx): Promise<LoginResult> => {
        const users = usersRepo(tx);
        const repo = authRepo(tx);

        // An identity already bound to a user signs in as that user, whatever its email says now.
        const bound = await repo.findOAuthBySubject(system, identity.provider, identityResult.subject);
        let user: UserRow | undefined =
          bound === undefined ? await users.findByEmail(system, email) : await users.findById(system, bound.userId);

        if (bound === undefined && user !== undefined) {
          // First sign-in by email. If this user is already bound to a different identity, refuse.
          const existing = await repo.findOAuthForUser(system, user.id, identity.provider);
          if (existing !== undefined && existing.subject !== identityResult.subject) {
            return refuse(tx, "identity_mismatch", { email }, input.ip);
          }
        }

        // The first admin comes from BOOTSTRAP_ADMIN_EMAIL, and only while there is no admin at all.
        if (user === undefined && email === config.BOOTSTRAP_ADMIN_EMAIL && (await users.countAdmins(system)) === 0) {
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
        if (user === undefined) return refuse(tx, "unknown_user", { email }, input.ip);
        if (!user.active) return refuse(tx, "inactive", { email }, input.ip);

        const now = clock();
        const sessionToken = randomToken(32);
        const idHash = sha256Hex(sessionToken);
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

    /** Ends whatever session a cookie names (used when signing in again on the same browser). */
    async endSessionByToken(token: string): Promise<void> {
      await authRepo(db).deleteSession(system, sha256Hex(token));
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
