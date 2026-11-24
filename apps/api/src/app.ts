import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { APP_ROLE, createDb, pingDatabase } from "@soa/db";
import type { Env } from "@soa/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createTokenCipher } from "./auth/crypto";
import { registerAuthGuard, registerRouteRegistry } from "./auth/plugin";
import { systemClock, type Clock } from "./clock";
import { registerErrorHandlers } from "./errors";
import { loggerOptions } from "./logger";
import { createFakeIdentityProvider } from "./providers/identity/fake";
import { createMicrosoftIdentityProvider } from "./providers/identity/microsoft";
import type { IdentityProvider } from "./providers/identity/types";
import { registerAuthRoutes } from "./routes/auth";
import { registerFakeIdpRoutes } from "./routes/fake-idp";
import { registerHealthRoutes } from "./routes/health";
import { registerUserRoutes } from "./routes/users";
import { registerRateLimits, registerSecurityHeaders } from "./security";
import { createAuditService } from "./services/audit";
import { createAuthService } from "./services/auth";
import { createHealthService } from "./services/health";
import { createUsersService } from "./services/users";

export interface BuildAppOptions {
  config: Env;
  logger?: FastifyServerOptions["logger"];
  clock?: Clock;
  /** Override the identity provider (tests). Defaults to the fake when FAKE_PROVIDERS=true, else Microsoft. */
  identity?: IdentityProvider;
  rateLimitPerMinute?: number;
}

function realIdentityProvider(config: Env): IdentityProvider {
  if (config.IDP !== "microsoft") throw new Error("Only IDP=microsoft has an adapter (DECISIONS.md decision 10)");
  const { OIDC_TENANT_ID, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = config;
  if (OIDC_TENANT_ID === undefined || OIDC_CLIENT_ID === undefined || OIDC_CLIENT_SECRET === undefined) {
    throw new Error("OIDC settings are required when FAKE_PROVIDERS=false");
  }
  return createMicrosoftIdentityProvider({
    tenantId: OIDC_TENANT_ID,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
  });
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const database = createDb(config.DATABASE_URL, { role: APP_ROLE });
  const app = Fastify({
    logger: options.logger ?? loggerOptions(config),
    trustProxy: config.NODE_ENV === "production",
  });
  app.addHook("onClose", async () => {
    await database.close();
  });

  try {
    registerRouteRegistry(app);
    registerErrorHandlers(app);
    registerSecurityHeaders(app);
    await app.register(cookie);
    await app.register(formbody);
    await registerRateLimits(app, { apiPerMinute: options.rateLimitPerMinute });

    const fakeIdentity = config.FAKE_PROVIDERS
      ? createFakeIdentityProvider({ appUrl: config.APP_URL, signingKey: config.SESSION_SECRET, clock })
      : undefined;
    const identity = options.identity ?? fakeIdentity ?? realIdentityProvider(config);
    const auth = createAuthService({
      db: database.db,
      config,
      clock,
      identity,
      cipher: createTokenCipher(config.TOKEN_ENC_KEY),
    });

    registerAuthGuard(app, auth);
    registerHealthRoutes(app, createHealthService({ isDatabaseUp: () => pingDatabase(database.pool) }));
    registerAuthRoutes(app, { auth, config });
    if (fakeIdentity !== undefined) {
      registerFakeIdpRoutes(app, { db: database.db, idp: fakeIdentity, redirectUri: auth.redirectUri });
    }
    registerUserRoutes(app, {
      users: createUsersService({ db: database.db, config }),
      audit: createAuditService({ db: database.db }),
      auth,
    });

    await app.ready();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
