import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isPermanentResendError,
  createResendClient,
  type ResendBatchMessage,
} from "@/lib/integrations/resend";

const { batchSend } = vi.hoisted(() => ({ batchSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    batch = { send: batchSend };
    constructor(_apiKey: string) {}
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

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
    batchSend.mockResolvedValue({ error: { message: "missing_required_field" } });
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

  it("parses the nested runtime batch shape { data: { data: [{ id }], errors: [...] } }", async () => {
    batchSend.mockResolvedValue({
      error: null,
      data: {
        data: [{ id: "msg-1" }, { id: "msg-2" }],
        errors: [{ index: 0, message: "validation_error: suppressed" }],
      },
    });
    const client = createResendClient({ apiKey: "re_test", fromEmail: "noreply@wlthwlks.com" });
    const results = await client.sendBatch([
      { to: ["a@example.com"], from: "x", subject: "s", html: "h" },
      { to: ["b@example.com"], from: "x", subject: "s", html: "h" },
    ]);
    // Index 0 has an explicit per-item error (permanent), index 1 succeeded.
    expect(results[0]).toMatchObject({ ok: false, permanent: true, id: null });
    expect(results[0].error).toContain("suppressed");
    expect(results[1]).toMatchObject({ ok: true, permanent: false, id: "msg-2" });
  });

  it("still accepts the flat typed batch shape { data: [{ id }] }", async () => {
    batchSend.mockResolvedValue({ error: null, data: [{ id: "msg-flat" }] });
    const client = createResendClient({ apiKey: "re_test", fromEmail: "noreply@wlthwlks.com" });
    const results = await client.sendBatch([
      { to: ["a@example.com"], from: "x", subject: "s", html: "h" },
    ]);
    expect(results[0]).toMatchObject({ ok: true, permanent: false, id: "msg-flat" });
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
