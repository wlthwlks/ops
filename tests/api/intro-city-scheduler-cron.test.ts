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

const route = await import("@/app/api/cron/intro-city-scheduler/route");
const { rejectUnauthorizedCron } = await import("@/lib/ops/cron-auth");
const { getIntroductionsMode } = await import("@/lib/introduction/runtime-mode");
const scheduler = await import("@/lib/introduction/scheduler");

describe("GET /api/cron/intro-city-scheduler", () => {
  beforeEach(() => {
    vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "pat_test");
    vi.stubEnv("AIRTABLE_BASE_ID", "app_test");
    vi.stubEnv("PINECONE_API_KEY", "pc_test");
    vi.stubEnv("PINECONE_INDEX_NAME", "idx_test");
    vi.clearAllMocks();
    vi.mocked(rejectUnauthorizedCron).mockReturnValue(null);
    vi.mocked(getIntroductionsMode).mockReturnValue("live");
    vi.mocked(scheduler.runCityIntroductionScheduler).mockResolvedValue({
      processed: true,
      live: true,
      dueCities: 1,
      results: [
        {
          cityCode: "rec_london",
          cycleDate: "2026-08-16",
          outcome: "previewed",
          runId: "run_1",
          error: null,
          nextRunAt: "2026-09-01T08:00:00.000Z",
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects unauthorized requests", async () => {
    vi.mocked(rejectUnauthorizedCron).mockReturnValueOnce(
      NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    );
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/intro-city-scheduler")
    );
    expect(response.status).toBe(401);
    expect(scheduler.runCityIntroductionScheduler).not.toHaveBeenCalled();
  });

  it("runs the scheduler with the live flag and returns results", async () => {
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/intro-city-scheduler")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toBe(true);
    expect(body.live).toBe(true);
    expect(body.results[0].outcome).toBe("previewed");
    expect(scheduler.runCityIntroductionScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ live: true })
    );
  });

  it("passes live=false in read-only mode", async () => {
    vi.mocked(getIntroductionsMode).mockReturnValue("read_only");
    await route.GET(new NextRequest("http://localhost/api/cron/intro-city-scheduler"));
    expect(scheduler.runCityIntroductionScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ live: false })
    );
  });

  it("reports missing integration config as a 500 skip", async () => {
    vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "");
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/intro-city-scheduler")
    );
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("integrations_not_configured");
  });
});
