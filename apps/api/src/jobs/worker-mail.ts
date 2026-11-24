import type { Env } from "@soa/shared";
import type { Clock } from "../clock";
import { createGraphMailProvider } from "../providers/mail/graph";
import { createMailpitMailProvider } from "../providers/mail/mailpit";
import type { MailProvider } from "../providers/mail/types";

/** The worker's mailbox provider: Mailpit with FAKE_PROVIDERS, otherwise Microsoft Graph. */
export function createWorkerMail(config: Env, clock: Clock): MailProvider {
  if (config.FAKE_PROVIDERS) {
    return createMailpitMailProvider({ smtpUrl: config.MAILPIT_SMTP_URL, apiUrl: config.MAILPIT_API_URL });
  }
  const { OIDC_TENANT_ID, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = config;
  if (
    config.IDP !== "microsoft" ||
    OIDC_TENANT_ID === undefined ||
    OIDC_CLIENT_ID === undefined ||
    OIDC_CLIENT_SECRET === undefined
  ) {
    throw new Error("Mail needs IDP=microsoft and the OIDC settings when FAKE_PROVIDERS=false");
  }
  return createGraphMailProvider({
    tenantId: OIDC_TENANT_ID,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    clock,
  });
}
