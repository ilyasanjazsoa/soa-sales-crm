import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

/** An error with an HTTP status and a stable code, rendered as { error: { code, message, details? } }. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in to continue.");
export const forbidden = (message = "You don't have access to this.") => new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);

/** What an unexpected error was, without its message (CLAUDE.md rule 8). */
export function describeError(error: unknown): Record<string, unknown> {
  const described: Record<string, unknown> = { name: error instanceof Error ? error.name : typeof error };
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  for (const candidate of [error, cause]) {
    if (candidate === null || typeof candidate !== "object") continue;
    const source = candidate as Record<string, unknown>;
    for (const key of ["code", "constraint", "table", "column", "routine"]) {
      if (typeof source[key] === "string" && described[key] === undefined) described[key] = source[key];
    }
  }
  if (error instanceof Error && error.stack !== undefined) {
    // Only real stack frames: a multi-line message (e.g. "params: …" from the database driver) is dropped.
    described.at = error.stack
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("at "))
      .slice(0, 3);
  }
  return described;
}

/** Validation issues without the submitted values. */
const issuesOf = (error: ZodError) =>
  error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | HttpError | ZodError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "validation_failed", message: "Some fields are not valid.", details: issuesOf(error) },
      });
    }
    if (error.statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: "rate_limited", message: "Too many requests. Try again shortly." } });
    }
    if (error.statusCode === 413) {
      return reply.code(413).send({ error: { code: "too_large", message: "The file is larger than 10 MB." } });
    }
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: "bad_request", message: "The request is not valid." } });
    }
    // Never log error messages: database errors include query parameters, which can hold email bodies or tokens.
    request.log.error({ err: describeError(error) }, "request failed");
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong. Try again." } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Not found." } }),
  );
}
