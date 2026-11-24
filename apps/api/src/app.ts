import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { APP_ROLE, appRoleProblems, createDb, pingDatabase } from "@soa/db";
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
import { registerCrmRoutes } from "./routes/crm";
import { registerResearchRoutes } from "./routes/research";
import { createResearchService } from "./services/research";
import { createAiClient } from "./providers/ai/client";
import { createBedrockAdapter } from "./providers/ai/bedrock";
import { createFakeAiAdapter } from "./providers/ai/fake";
import type { AiAdapter } from "./providers/ai/types";
import { createPgBossQueue, type JobQueue } from "./jobs/queue";
import { createS3ObjectStore, type ObjectStore } from "./providers/storage";
import { createAccountsService } from "./services/accounts";
import { createDealsService } from "./services/deals";
import { createExportService } from "./services/export";
import { createImportsService } from "./services/imports";
import { createTasksService } from "./services/tasks";
import { RateLimiter, registerSecurityHeaders } from "./security";
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
  /** Requests a minute per signed-in session (default 300, §15). */
  rateLimitPerMinute?: number;
  /** Requests a minute per client address before the session check (default 2000; offices share an address). */
  ipRateLimitPerMinute?: number;
  /** File storage; defaults to S3 (MinIO locally). */
  store?: ObjectStore;
  /** AI adapter; defaults to the fake when FAKE_PROVIDERS=true, else Bedrock. */
  aiAdapter?: AiAdapter;
  /** Job queue; defaults to pg-boss in Postgres. */
  queue?: JobQueue;
  /** Refuse to start when the database login can bypass the app role (default: in production). */
  enforceAppRoleLogin?: boolean;
}

function realIdentityProvider(config: Env, clock: Clock): IdentityProvider {
  if (config.IDP !== "microsoft") throw new Error("Only IDP=microsoft has an adapter (DECISIONS.md decision 10)");
  const { OIDC_TENANT_ID, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = config;
  if (OIDC_TENANT_ID === undefined || OIDC_CLIENT_ID === undefined || OIDC_CLIENT_SECRET === undefined) {
    throw new Error("OIDC settings are required when FAKE_PROVIDERS=false");
  }
  return createMicrosoftIdentityProvider({
    tenantId: OIDC_TENANT_ID,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    clock,
  });
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const database = createDb(config.DATABASE_URL, { role: APP_ROLE });
  const app = Fastify({
    logger: options.logger ?? loggerOptions(config),
    // Exactly one proxy (the load balancer) in production, so client-supplied X-Forwarded-For can't spoof the IP.
    trustProxy: config.NODE_ENV === "production" ? (_address: string, hop: number) => hop < 1 : false,
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
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } });

    const store = options.store ?? createS3ObjectStore(config);
    const queue = options.queue ?? (await createPgBossQueue(config.DATABASE_URL));
    app.addHook("onClose", async () => {
      await queue.stop();
    });

    if (options.enforceAppRoleLogin ?? config.NODE_ENV === "production") {
      const problems = await appRoleProblems(database.pool);
      if (problems.length > 0) {
        throw new Error(
          `DATABASE_URL must be a login role that is a member of ${APP_ROLE} and not the schema owner: ${problems.join("; ")}`,
        );
      }
    }

    const fakeIdentity = config.FAKE_PROVIDERS
      ? createFakeIdentityProvider({ appUrl: config.APP_URL, signingKey: config.SESSION_SECRET, clock })
      : undefined;
    const identity = options.identity ?? fakeIdentity ?? realIdentityProvider(config, clock);
    const auth = createAuthService({
      db: database.db,
      config,
      clock,
      identity,
      cipher: createTokenCipher(config.TOKEN_ENC_KEY),
    });

    registerAuthGuard(app, {
      auth,
      ipLimiter: new RateLimiter(options.ipRateLimitPerMinute ?? 2000, clock),
      sessionLimiter: new RateLimiter(options.rateLimitPerMinute ?? 300, clock),
    });
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

    const db = database.db;
    registerCrmRoutes(app, {
      accounts: createAccountsService({ db, clock }),
      deals: createDealsService({ db, clock }),
      tasks: createTasksService({ db, clock }),
      imports: createImportsService({ db, store, queue }),
      exports: createExportService({ db }),
    });

    const ai = createAiClient({
      db,
      adapter:
        options.aiAdapter ??
        (config.FAKE_PROVIDERS ? createFakeAiAdapter() : createBedrockAdapter({ region: config.AWS_REGION })),
      config,
      clock,
    });
    registerResearchRoutes(app, { research: createResearchService({ db, queue, ai, clock }) });

    await app.ready();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
