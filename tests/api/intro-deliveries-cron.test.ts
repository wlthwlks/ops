import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/lib/ops/cron-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/cron-auth")>();
  return {
    ...actual,
    rejectUnauthorizedCron: vi.fn().mockReturnValue(null),
  };
});

vi.mock("@/lib/introduction/runtime-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/runtime-mode")>();
  return {
    ...actual,
    getIntroductionsMode: vi.fn().mockReturnValue("live"),
  };
});

vi.mock("@/lib/integrations/resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/resend")>();
  return {
    ...actual,
    createResendClient: vi.fn(() => ({ sendBatch: vi.fn() })),
  };
});

vi.mock("@/lib/introduction/delivery-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/delivery-queue")>();
  return {
    ...actual,
    processDeliveryBatch: vi.fn(),
    resendGroupEmailSender: vi.fn(() => ({ sendBatch: vi.fn() })),
  };
});

const route = await import("@/app/api/cron/intro-deliveries/route");
const { rejectUnauthorizedCron } = await import("@/lib/ops/cron-auth");
const { getIntroductionsMode } = await import("@/lib/introduction/runtime-mode");
const queue = await import("@/lib/introduction/delivery-queue");

const tickResult = {
  processed: true,
  skipped: false,
  reason: null,
  claimed: 2,
  sent: 2,
  failed: 0,
  deferred: 0,
  reclaimed: 0,
  staleGroupsReset: 0,
};

describe("GET /api/cron/intro-deliveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("INTRO_DELIVERY_WORKER_BATCH_SIZE", "20");
    vi.mocked(rejectUnauthorizedCron).mockReturnValue(null);
    vi.mocked(getIntroductionsMode).mockReturnValue("live");
    vi.mocked(queue.processDeliveryBatch).mockResolvedValue(tickResult);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects unauthorized requests", async () => {
    vi.mocked(rejectUnauthorizedCron).mockReturnValueOnce(
      NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    );
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/intro-deliveries")
    );
    expect(response.status).toBe(401);
    expect(queue.processDeliveryBatch).not.toHaveBeenCalled();
  });

  it("processes a batch when live", async () => {
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/intro-deliveries")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toBe(true);
    expect(body.live).toBe(true);
    expect(body.sent).toBe(2);
    expect(queue.processDeliveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ live: true }),
      expect.objectContaining({ batchSize: 20 })
    );
  });

  it("skips sending in read-only mode", async () => {
    vi.mocked(getIntroductionsMode).mockReturnValue("read_only");
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/intro-deliveries")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toBe(false);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("read_only");
    expect(queue.processDeliveryBatch).not.toHaveBeenCalled();
  });

  it("honors the batch size env var", async () => {
    vi.stubEnv("INTRO_DELIVERY_WORKER_BATCH_SIZE", "7");
    await route.GET(new NextRequest("http://localhost/api/cron/intro-deliveries"));
    expect(queue.processDeliveryBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ batchSize: 7 })
    );
  });
});
