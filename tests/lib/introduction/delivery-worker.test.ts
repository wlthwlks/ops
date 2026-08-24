import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

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

vi.mock("@/lib/introduction/runtime-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/runtime-mode")>();
  return {
    ...actual,
    getIntroductionsMode: vi.fn().mockReturnValue("live"),
  };
});

const worker = await import("@/lib/introduction/delivery-worker");
const runtimeMode = await import("@/lib/introduction/runtime-mode");
const queue = await import("@/lib/introduction/delivery-queue");

const getIntroductionsMode = vi.mocked(runtimeMode.getIntroductionsMode);
const processDeliveryBatch = vi.mocked(queue.processDeliveryBatch);

describe("runDeliveryWorkerTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INTRODUCTIONS_MODE", "live");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("INTRO_DELIVERY_WORKER_BATCH_SIZE", "20");
    getIntroductionsMode.mockReturnValue("live");
    processDeliveryBatch.mockResolvedValue({
      processed: true,
      skipped: false,
      reason: null,
      claimed: 1,
      sent: 1,
      failed: 0,
      deferred: 0,
      reclaimed: 0,
      staleGroupsReset: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns read_only when introductions are not live", async () => {
    getIntroductionsMode.mockReturnValue("read_only");
    const outcome = await worker.runDeliveryWorkerTick();
    expect(outcome).toMatchObject({ ok: false, reason: "read_only" });
    expect(processDeliveryBatch).not.toHaveBeenCalled();
  });

  it("returns resend_not_configured when the API key is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const outcome = await worker.runDeliveryWorkerTick();
    expect(outcome).toMatchObject({ ok: false, reason: "resend_not_configured" });
    expect(processDeliveryBatch).not.toHaveBeenCalled();
  });

  it("runs the batch and returns the tick result with logs", async () => {
    const outcome = await worker.runDeliveryWorkerTick();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.response).toMatchObject({
      live: true,
      batchSize: 20,
      claimed: 1,
      sent: 1,
      logs: [],
    });
    expect(processDeliveryBatch).toHaveBeenCalledTimes(1);
    expect(processDeliveryBatch.mock.calls[0][1]).toEqual({ batchSize: 20 });
  });

  it("clamps the configured batch size to 100", async () => {
    vi.stubEnv("INTRO_DELIVERY_WORKER_BATCH_SIZE", "500");
    const outcome = await worker.runDeliveryWorkerTick();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.response.batchSize).toBe(100);
  });

  it("collects worker logs", async () => {
    processDeliveryBatch.mockImplementation(async (deps) => {
      deps.log("claimed 1");
      deps.log("sent 1");
      return {
        processed: true,
        skipped: false,
        reason: null,
        claimed: 1,
        sent: 1,
        failed: 0,
        deferred: 0,
        reclaimed: 0,
        staleGroupsReset: 0,
      };
    });
    const outcome = await worker.runDeliveryWorkerTick();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.response.logs).toEqual(["claimed 1", "sent 1"]);
  });
});
