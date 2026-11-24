import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

export const sha256Base64Url = (value: string): string => createHash("sha256").update(value).digest("base64url");

export const hmac = (key: string | Buffer, value: string): string =>
  createHmac("sha256", key).update(value).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `payload.signature`, where payload is base64url JSON. Used for short-lived values in cookies and fake codes. */
export function sign(key: string | Buffer, data: unknown): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${hmac(key, payload)}`;
}

export function verify(key: string | Buffer, token: string): unknown {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) return undefined;
  if (!safeEqual(signature, hmac(key, payload))) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const VERSION = 1;

/** AES-256-GCM for OAuth tokens at rest (ARCHITECTURE.md §15). Layout: version | iv(12) | tag(16) | ciphertext. */
export interface TokenCipher {
  encrypt: (plaintext: string) => Buffer;
  decrypt: (box: Buffer) => string;
}

export function createTokenCipher(hexKey: string): TokenCipher {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes");
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(box) {
      if (box[0] !== VERSION) throw new Error("Unknown token encryption version");
      const decipher = createDecipheriv("aes-256-gcm", key, box.subarray(1, 13));
      decipher.setAuthTag(box.subarray(13, 29));
      return Buffer.concat([decipher.update(box.subarray(29)), decipher.final()]).toString("utf8");
    },
  };
}
