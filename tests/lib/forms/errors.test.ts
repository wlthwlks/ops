import { describe, it, expect } from "vitest";
import { redactSecrets, sanitizePayload } from "@/lib/forms/errors";

describe("error redaction", () => {
  it("redacts stripe and slack secrets", () => {
    const s = redactSecrets("key sk_live_abc123XYZ and xoxb-123-456-token");
    expect(s).not.toContain("sk_live_abc");
    expect(s).toContain("[redacted]");
  });

  it("strips password fields from payloads", () => {
    const out = sanitizePayload({
      email: "a@b.com",
      password: "secret",
      nested: { authorization: "Bearer xyz" },
    }) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).authorization).toBe("[redacted]");
  });
});
