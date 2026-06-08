import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB import used inside the route
vi.mock("@/db", () => ({ db: {} }));

// Mock runDailyMatchMessage before importing the route
vi.mock("@/lib/ops/daily-match-message", () => ({
  runDailyMatchMessage: vi.fn(),
}));

const { runDailyMatchMessage } = await import("@/lib/ops/daily-match-message");
const { POST } = await import("@/app/api/send-match-intros/route");

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/send-match-intros", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/send-match-intros", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runDailyMatchMessage).mockResolvedValue({
      success: true,
      summary: "1 processed",
      deliveries: [],
    });
  });

  it("returns 400 when neither emails nor startDate+endDate provided", async () => {
    const res = await POST(makeRequest({ mode: "preview" }) as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("emails");
  });

  it("returns 400 when only startDate provided (missing endDate)", async () => {
    const res = await POST(makeRequest({ startDate: "2026-01-01", mode: "preview" }) as any);
    expect(res.status).toBe(400);
  });

  it("accepts request with emails array (no dates required)", async () => {
    const res = await POST(makeRequest({ emails: ["a@test.com"], mode: "preview" }) as any);
    expect(res.status).toBe(200);
    expect(runDailyMatchMessage).toHaveBeenCalledOnce();
  });

  it("forwards editedMessages verbatim to runDailyMatchMessage", async () => {
    const editedMessages = { "a@test.com": "custom slack" };
    await POST(makeRequest({ emails: ["a@test.com"], mode: "send", editedMessages }) as any);
    const call = vi.mocked(runDailyMatchMessage).mock.calls[0];
    expect(call[5]).toEqual(editedMessages);
  });

  it("forwards editedEmails verbatim to runDailyMatchMessage", async () => {
    const editedEmails = { "a@test.com": "<p>custom html</p>" };
    await POST(makeRequest({ emails: ["a@test.com"], mode: "send", editedEmails }) as any);
    const call = vi.mocked(runDailyMatchMessage).mock.calls[0];
    expect(call[6]).toEqual(editedEmails);
  });

  it("response body includes logs array alongside function result", async () => {
    const res = await POST(makeRequest({ startDate: "2026-01-01", endDate: "2026-01-01", mode: "preview" }) as any);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.summary).toBe("1 processed");
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it("passes mode from body to runDailyMatchMessage", async () => {
    await POST(makeRequest({ startDate: "2026-01-01", endDate: "2026-01-01", mode: "send" }) as any);
    const call = vi.mocked(runDailyMatchMessage).mock.calls[0];
    expect(call[3]).toBe("send");
  });
});
