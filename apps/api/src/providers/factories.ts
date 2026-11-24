import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "@soa/shared";
import type { Clock } from "../clock";
import type { TokenRefresher } from "../services/oauth-tokens";
import { createFakeCalendarProvider } from "./calendar/fake";
import { createGraphCalendarProvider } from "./calendar/graph";
import type { CalendarProvider } from "./calendar/types";
import { createFakeTokenRefresher, createMicrosoftTokenRefresher } from "./identity/refresh";
import { createFakeMapsProvider } from "./maps/fake";
import { createGoogleMapsProvider } from "./maps/google";
import type { MapsProvider } from "./maps/types";

/* The real or fake provider for each external service, chosen from the configuration (FAKE_PROVIDERS). The api and
   the worker build theirs here, so both use the same fakes locally. */

function microsoft(config: Env) {
  const { OIDC_TENANT_ID, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = config;
  if (
    config.IDP !== "microsoft" ||
    OIDC_TENANT_ID === undefined ||
    OIDC_CLIENT_ID === undefined ||
    OIDC_CLIENT_SECRET === undefined
  ) {
    throw new Error("Mail and calendar need IDP=microsoft and the OIDC settings when FAKE_PROVIDERS=false");
  }
  return { tenantId: OIDC_TENANT_ID, clientId: OIDC_CLIENT_ID, clientSecret: OIDC_CLIENT_SECRET };
}

export function createTokenRefresher(config: Env, clock: Clock): TokenRefresher {
  return config.FAKE_PROVIDERS
    ? createFakeTokenRefresher(clock)
    : createMicrosoftTokenRefresher({ ...microsoft(config), clock });
}

/** The fake calendar is a file per database, so the api (booking) and the worker (sync) share it locally. */
export function createCalendarProvider(config: Env): CalendarProvider {
  if (!config.FAKE_PROVIDERS) return createGraphCalendarProvider();
  const name = createHash("sha256").update(config.DATABASE_URL).digest("hex").slice(0, 12);
  return createFakeCalendarProvider({ file: join(tmpdir(), "soa-crm-fake-calendar", `${name}.json`) }).provider;
}

export function createMapsProvider(config: Env): MapsProvider {
  if (config.FAKE_PROVIDERS) return createFakeMapsProvider();
  if (config.MAPS_PROVIDER === "google" && config.MAPS_API_KEY !== undefined) {
    return createGoogleMapsProvider({ apiKey: config.MAPS_API_KEY });
  }
  // No maps vendor configured: every drive time falls back to the estimate and is labelled so.
  return {
    geocode: () => Promise.reject(new Error("No maps provider configured")),
    driveMinutes: () => Promise.reject(new Error("No maps provider configured")),
  };
}
