import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => state.rows,
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
      __state: state,
    },
  };
});

vi.mock("@/lib/forms/webhooks/memberstack-handlers", () => ({
  handleMemberstackEvent: vi.fn(async () => ({
    processed: true,
    status: "succeeded",
    reason: "ok",
  })),
}));

vi.mock("@/lib/forms/webhooks/store", () => ({
  updateWebhookEventStatus: vi.fn(async () => undefined),
  recordIntegrationError: vi.fn(async () => "err1"),
}));

describe("reprocessWebhookEvent", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns already succeeded without re-running business logic", async () => {
    const { db } = await import("@/db");
    (db as unknown as { __state: { rows: unknown[] } }).__state.rows = [
      {
        id: "w1",
        provider: "memberstack",
        eventType: "member.created",
        status: "SUCCEEDED",
        attemptCount: 1,
        sanitizedPayload: "{}",
      },
    ];
    const { reprocessWebhookEvent } = await import("@/lib/forms/webhooks/reprocess");
    const { handleMemberstackEvent } = await import(
      "@/lib/forms/webhooks/memberstack-handlers"
    );
    const r = await reprocessWebhookEvent("w1");
    expect(r.status).toBe("SUCCEEDED");
    expect(r.reason).toMatch(/Already succeeded/i);
    expect(handleMemberstackEvent).not.toHaveBeenCalled();
  });

  it("reprocesses failed memberstack event", async () => {
    const { db } = await import("@/db");
    (db as unknown as { __state: { rows: unknown[] } }).__state.rows = [
      {
        id: "w2",
        provider: "memberstack",
        eventType: "member.created",
        status: "FAILED",
        attemptCount: 0,
        sanitizedPayload: JSON.stringify({ type: "member.created", data: {} }),
      },
    ];
    vi.resetModules();
    vi.doMock("@/lib/forms/webhooks/memberstack-handlers", () => ({
      handleMemberstackEvent: vi.fn(async () => ({
        processed: true,
        status: "succeeded",
        reason: "Minimal member ensured",
      })),
    }));
    vi.doMock("@/lib/forms/webhooks/store", () => ({
      updateWebhookEventStatus: vi.fn(async () => undefined),
      recordIntegrationError: vi.fn(async () => "err1"),
    }));
    // Re-import db mock state after resetModules loses it — re-setup
    vi.doMock("@/db", () => {
      const state = {
        rows: [
          {
            id: "w2",
            provider: "memberstack",
            eventType: "member.created",
            status: "FAILED",
            attemptCount: 0,
            sanitizedPayload: JSON.stringify({ type: "member.created" }),
          },
        ],
      };
      return {
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => state.rows,
              }),
            }),
          }),
          update: () => ({
            set: () => ({
              where: async () => undefined,
            }),
          }),
        },
      };
    });
    const { reprocessWebhookEvent } = await import("@/lib/forms/webhooks/reprocess");
    const r = await reprocessWebhookEvent("w2");
    expect(r.status).toBe("SUCCEEDED");
  });
});
