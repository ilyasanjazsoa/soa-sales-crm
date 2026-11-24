import { randomUUID } from "node:crypto";
import { renderAgreementPdf } from "../pdf";
import { signDropboxSignEvent, verifyDropboxSignEvent } from "./dropbox-sign";
import type { ESignProvider } from "./types";

/* FAKE_PROVIDERS e-signature: keeps envelopes in memory and produces callbacks signed exactly like Dropbox Sign's,
   so the real webhook route and verification run locally. `callback` builds one ("signed", "viewed" …). */
export function createFakeESignProvider(options: { webhookKey: string }) {
  const envelopes = new Map<string, { document: Buffer; voided: boolean; signers: string[] }>();
  const provider: ESignProvider = {
    name: "fake",
    createEnvelope(request) {
      const envelopeId = `fake-envelope-${randomUUID()}`;
      envelopes.set(envelopeId, {
        document: request.document,
        voided: false,
        signers: request.signers.map((s) => s.email),
      });
      return Promise.resolve({ envelopeId });
    },
    voidEnvelope(envelopeId) {
      const envelope = envelopes.get(envelopeId);
      if (envelope !== undefined) envelope.voided = true;
      return Promise.resolve();
    },
    downloadSigned(envelopeId) {
      const envelope = envelopes.get(envelopeId);
      // After a local restart the envelope is gone; a placeholder keeps the flow working.
      return envelope === undefined
        ? renderAgreementPdf({
            companyName: "Fake e-signature",
            companyAddress: null,
            companySigner: null,
            accountName: "Signed copy (fake e-signature)",
            accountAddress: null,
            signerName: "Signed",
            signerEmail: "signed@fake.example",
            lines: [],
            monthlyCents: 0,
            annualCents: 0,
            termMonths: 12,
            startDate: "",
          })
        : Promise.resolve(envelope.document);
    },
    verifyWebhook: (json) => verifyDropboxSignEvent(json, options.webhookKey),
  };
  const TYPE = {
    viewed: "signature_request_viewed",
    signed: "signature_request_all_signed",
    declined: "signature_request_declined",
    voided: "signature_request_canceled",
  } as const;
  return {
    provider,
    envelopes,
    callback: (type: keyof typeof TYPE, envelopeId: string, time = String(Math.floor(Date.now() / 1000))) =>
      signDropboxSignEvent(options.webhookKey, TYPE[type], envelopeId, time),
  };
}
