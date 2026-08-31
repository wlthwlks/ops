import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/db", () => ({ db: {} }));

const authMock = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

vi.mock("@/lib/introduction/runtime-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/runtime-mode")>();
  return {
    ...actual,
    getIntroductionsMode: vi.fn().mockReturnValue("live"),
  };
});

vi.mock("@/lib/integrations/airtable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/airtable")>();
  return { ...actual, createAirtableClient: vi.fn(() => ({})), };
});

vi.mock("@/lib/integrations/pinecone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/pinecone")>();
  return { ...actual, createPineconeClient: vi.fn(() => ({})), };
});

vi.mock("@/lib/introduction/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/scheduler")>();
  return {
    ...actual,
    runCityIntroductionScheduler: vi.fn(),
  };
});

const route = await import("@/app/api/introductions/city-scheduler/run/route");
const { getIntroductionsMode } = await import("@/lib/introduction/runtime-mode");
const scheduler = await import("@/lib/introduction/scheduler");

const schedulerResult = {
  processed: true,
  live: true,
  dueCities: 1,
  results: [
    {
      cityCode: "rec_melbourne",
      cycleDate: "2026-08-31",
      outcome: "approved",
      runId: "run_1",
      error: null,
      nextRunAt: "2026-10-01T09:00:00.000+12:00",
    },
  ],
} satisfies import("@/lib/introduction/scheduler").SchedulerRunResult;

describe("POST /api/introductions/city-scheduler/run", () => {
  beforeEach(() => {
    vi.stubEnv("OPS_ADMIN_USER_IDS", "user_admin");
    vi.stubEnv("OPS_VIEWER_USER_IDS", "user_viewer");
    vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "pat_test");
    vi.stubEnv("AIRTABLE_BASE_ID", "app_test");
    vi.stubEnv("PINECONE_API_KEY", "pc_test");
    vi.stubEnv("PINECONE_INDEX_NAME", "idx_test");
    vi.clearAllMocks();
    vi.mocked(getIntroductionsMode).mockReturnValue("live");
    vi.mocked(scheduler.runCityIntroductionScheduler).mockResolvedValue(schedulerResult);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects unauthenticated requests", async () => {
    authMock.mockResolvedValue({ userId: null });
    const response = await route.POST();
    expect(response.status).toBe(401);
    expect(scheduler.runCityIntroductionScheduler).not.toHaveBeenCalled();
  });

  it("rejects non-admin viewers", async () => {
    authMock.mockResolvedValue({ userId: "user_viewer" });
    const response = await route.POST();
    expect(response.status).toBe(403);
    expect(scheduler.runCityIntroductionScheduler).not.toHaveBeenCalled();
  });

  it("runs the scheduler with the live flag and returns results", async () => {
    authMock.mockResolvedValue({ userId: "user_admin" });
    const response = await route.POST();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toBe(true);
    expect(body.live).toBe(true);
    expect(body.dueCities).toBe(1);
    expect(body.results[0].outcome).toBe("approved");
    expect(scheduler.runCityIntroductionScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ live: true })
    );
  });

  it("passes live=false in read-only mode", async () => {
    authMock.mockResolvedValue({ userId: "user_admin" });
    vi.mocked(getIntroductionsMode).mockReturnValue("read_only");
    await route.POST();
    expect(scheduler.runCityIntroductionScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ live: false })
    );
  });

  it("reports missing integration config as a 500 skip", async () => {
    authMock.mockResolvedValue({ userId: "user_admin" });
    vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "");
    const response = await route.POST();
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("integrations_not_configured");
    expect(scheduler.runCityIntroductionScheduler).not.toHaveBeenCalled();
  });

  it("reports scheduler failures as a 500 skip", async () => {
    authMock.mockResolvedValue({ userId: "user_admin" });
    vi.mocked(scheduler.runCityIntroductionScheduler).mockRejectedValueOnce(
      new Error("boom")
    );
    const response = await route.POST();
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("scheduler_failed");
  });
});
