import { hmac, safeEqual } from "../auth/crypto";

/* The unsubscribe token (§8.2): base64url(contactEmail) + "." + HMAC-SHA256(contactEmail, UNSUBSCRIBE_SECRET).
   No table is needed; the token works for as long as the secret is unchanged. */

const key = (secret: string) => Buffer.from(secret, "hex");

export function unsubscribeToken(secret: string, email: string): string {
  const address = email.trim().toLowerCase();
  return `${Buffer.from(address).toString("base64url")}.${hmac(key(secret), address)}`;
}

/** The address a token was made for, or undefined when it was not made with this secret. */
export function readUnsubscribeToken(secret: string, token: string): string | undefined {
  const [encoded, signature, extra] = token.split(".");
  if (encoded === undefined || signature === undefined || extra !== undefined) return undefined;
  const address = Buffer.from(encoded, "base64url").toString("utf8");
  if (address === "" || !address.includes("@")) return undefined;
  return safeEqual(signature, hmac(key(secret), address)) ? address : undefined;
}

export const unsubscribeUrl = (publicUrl: string, secret: string, email: string) =>
  `${publicUrl.replace(/\/$/, "")}/u/${unsubscribeToken(secret, email)}`;
