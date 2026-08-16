import { describe, it, expect } from "vitest";
import {
  isPermanentResendError,
  createResendClient,
  type ResendBatchMessage,
} from "@/lib/integrations/resend";

describe("isPermanentResendError", () => {
  it("classifies validation and suppression errors as permanent", () => {
    expect(isPermanentResendError("validation_error: invalid from address")).toBe(true);
    expect(isPermanentResendError("The recipient was suppressed")).toBe(true);
    expect(isPermanentResendError("invalid_to_address")).toBe(true);
    expect(isPermanentResendError("missing_required_field")).toBe(true);
  });

  it("classifies rate limits and provider hiccups as transient", () => {
    expect(isPermanentResendError("rate_limit_exceeded")).toBe(false);
    expect(isPermanentResendError("daily_quota_exceeded")).toBe(false);
    expect(isPermanentResendError("internal_server_error")).toBe(false);
    expect(isPermanentResendError("connection timeout")).toBe(false);
    expect(isPermanentResendError("application_error")).toBe(false);
  });
});

describe("createResendClient.sendBatch", () => {
  it("returns per-message results; provider auth failures fall back to retryable results", async () => {
    const client = createResendClient({ apiKey: "re_test", fromEmail: "noreply@wlthwlks.com" });
    const results = await client.sendBatch([
      { to: ["a@example.com"], from: "x", subject: "s", html: "h" },
      { to: ["b@example.com"], from: "x", subject: "s", html: "h" },
      { to: ["c@example.com"], from: "x", subject: "s", html: "h" },
    ]);
    // Invalid key → SDK returns no ids and no explicit errors; the adapter
    // must not treat this as a permanent per-recipient failure (retries are
    // safe because of idempotency keys).
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => !r.permanent)).toBe(true);
  });

  it("returns empty for empty batches", async () => {
    const client = createResendClient({ apiKey: "re_test", fromEmail: "x" });
    expect(await client.sendBatch([])).toEqual([]);
  });
});

describe("ResendBatchMessage shape", () => {
  it("is structurally compatible with queue messages", () => {
    const message: ResendBatchMessage = {
      to: ["a@example.com", "b@example.com"],
      from: "WLTH WLKS <noreply@wlthwlks.com>",
      subject: "Hello",
      html: "<p>Hi</p>",
      replyTo: ["a@example.com", "b@example.com"],
      idempotencyKey: "intro-run-1-grp-1",
    };
    expect(message.to).toHaveLength(2);
  });
});
