import { describe, expect, it } from "vitest";
import { describeError } from "../src/errors";

describe("describeError", () => {
  it("keeps the kind of failure but never the message or query parameters", () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: "23505",
      constraint: "users_email_key",
    });
    const error = new Error('Failed query: insert into "users" ...\nparams: secret-body-text,token-123', { cause });
    const described = describeError(error);
    expect(described).toMatchObject({ name: "Error", code: "23505", constraint: "users_email_key" });
    expect(JSON.stringify(described)).not.toContain("secret-body-text");
    expect(JSON.stringify(described)).not.toContain("token-123");
  });
});
