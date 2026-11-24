import { ErrorResponse } from "@soa/shared";
import type { z } from "zod";

/* Typed calls to the api. Responses are validated with the shared Zod schemas. State-changing requests carry
   the CSRF token from /api/me. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | undefined;
export const setCsrfToken = (token: string | undefined) => {
  csrfToken = token;
};

const readCookie = (name: string) =>
  document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = csrfToken ?? readCookie("csrf") ?? "";

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
  }

  if (response.status === 204) return schema.parse(undefined);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = ErrorResponse.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
    }
    throw new ApiError(response.status, "unknown", `The server returned ${String(response.status)}.`);
  }
  return schema.parse(payload);
}
