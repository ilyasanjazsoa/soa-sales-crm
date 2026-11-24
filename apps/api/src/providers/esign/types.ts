/* Electronic signature (ARCHITECTURE.md §10.2). One real adapter (Dropbox Sign, DECISIONS.md item C) and a fake that
   speaks the same signed webhook format. */

export interface EnvelopeRequest {
  title: string;
  subject: string;
  message: string;
  document: Buffer;
  /** In signing order: the client's signer first, the company's signer second. */
  signers: { name: string; email: string }[];
  contractId: string;
}

export type ESignEventType = "viewed" | "signed" | "declined" | "voided" | "other";

export interface ESignEvent {
  /** Unique per event, used to ignore replays. */
  eventId: string;
  /** When the provider says the event happened. */
  occurredAt: Date;
  type: ESignEventType;
  envelopeId: string;
}

export interface ESignProvider {
  readonly name: string;
  createEnvelope: (request: EnvelopeRequest) => Promise<{ envelopeId: string }>;
  voidEnvelope: (envelopeId: string) => Promise<void>;
  downloadSigned: (envelopeId: string) => Promise<Buffer>;
  /** The envelope's state at the provider. A callback is only acted on when this agrees with it (the callback's own
      signature doesn't cover which envelope it is about). */
  status: (envelopeId: string) => Promise<"complete" | "declined" | "canceled" | "pending" | "unknown">;
  /** The verified event from a webhook's `json` field, or null when the signature doesn't match. */
  verifyWebhook: (json: string) => ESignEvent | null;
}
