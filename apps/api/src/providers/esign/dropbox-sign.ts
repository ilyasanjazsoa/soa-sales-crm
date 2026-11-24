import { createHmac } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "../../auth/crypto";
import type { ESignEvent, ESignEventType, ESignProvider } from "./types";

/* Dropbox Sign API v3. Callbacks arrive as multipart/form-data with a `json` field; the event is authentic when
   event_hash = HMAC-SHA256(key, event_time + event_type) in hex. The callback must answer
   "Hello API Event Received". */

const API = "https://api.hellosign.com/v3";

const Callback = z.object({
  event: z.object({ event_time: z.string(), event_type: z.string(), event_hash: z.string() }),
  signature_request: z.object({ signature_request_id: z.string() }).optional(),
});

const TYPES: Record<string, ESignEventType> = {
  signature_request_viewed: "viewed",
  signature_request_all_signed: "signed",
  signature_request_declined: "declined",
  signature_request_canceled: "voided",
};

/** Verifies and reads a Dropbox Sign callback (also used by the fake, with its own key). */
export function verifyDropboxSignEvent(json: string, key: string): ESignEvent | null {
  let parsed;
  try {
    parsed = Callback.safeParse(JSON.parse(json));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const { event, signature_request: request } = parsed.data;
  const expected = createHmac("sha256", key).update(`${event.event_time}${event.event_type}`).digest("hex");
  if (!safeEqual(expected, event.event_hash.toLowerCase())) return null;
  return {
    eventId: `${event.event_type}:${event.event_time}:${request?.signature_request_id ?? ""}`,
    type: TYPES[event.event_type] ?? "other",
    envelopeId: request?.signature_request_id ?? "",
  };
}

/** A signed callback body, as Dropbox Sign would send it (the fake and the tests use this). */
export function signDropboxSignEvent(key: string, type: string, envelopeId: string, time: string): string {
  const hash = createHmac("sha256", key).update(`${time}${type}`).digest("hex");
  return JSON.stringify({
    event: { event_time: time, event_type: type, event_hash: hash, event_metadata: {} },
    signature_request: { signature_request_id: envelopeId },
  });
}

export function createDropboxSignProvider(options: {
  apiKey: string;
  /** The key callbacks are signed with (Dropbox Sign uses the API key). */
  webhookKey: string;
  testMode: boolean;
  fetch?: typeof fetch;
}): ESignProvider {
  const http = options.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await http(`${API}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: auth },
    });
    if (!response.ok) throw new Error(`Dropbox Sign error ${String(response.status)}`);
    return response;
  };
  return {
    name: "dropbox_sign",
    async createEnvelope(request) {
      const form = new FormData();
      form.append("title", request.title);
      form.append("subject", request.subject);
      form.append("message", request.message);
      form.append("test_mode", options.testMode ? "1" : "0");
      form.append("metadata[contract_id]", request.contractId);
      request.signers.forEach((signer, index) => {
        form.append(`signers[${String(index)}][name]`, signer.name);
        form.append(`signers[${String(index)}][email_address]`, signer.email);
        form.append(`signers[${String(index)}][order]`, String(index));
      });
      form.append("files[0]", new Blob([new Uint8Array(request.document)], { type: "application/pdf" }), "agreement.pdf");
      const body = z
        .object({ signature_request: z.object({ signature_request_id: z.string() }) })
        .parse(await (await call("/signature_request/send", { method: "POST", body: form })).json());
      return { envelopeId: body.signature_request.signature_request_id };
    },
    async voidEnvelope(envelopeId) {
      await call(`/signature_request/cancel/${encodeURIComponent(envelopeId)}`, { method: "POST" });
    },
    async downloadSigned(envelopeId) {
      const response = await call(`/signature_request/files/${encodeURIComponent(envelopeId)}?file_type=pdf`);
      return Buffer.from(await response.arrayBuffer());
    },
    verifyWebhook: (json) => verifyDropboxSignEvent(json, options.webhookKey),
  };
}
