import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/ops/cron-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/cron-auth")>();
  return {
    ...actual,
    rejectUnauthorizedCron: vi.fn().mockReturnValue(null),
  };
});

vi.mock("@/lib/ops/recurring-city-intros", () => ({
  runRecurringCityIntros: vi.fn(),
}));

vi.mock("@/lib/introduction/runtime-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/runtime-mode")>();
  return {
    ...actual,
    getIntroductionsMode: vi.fn().mockReturnValue("live"),
  };
});

const route = await import("@/app/api/cron/recurring-intros/route");
const { runRecurringCityIntros } = await import("@/lib/ops/recurring-city-intros");

describe("GET /api/cron/recurring-intros — legacy cutover gate", () => {
  beforeEach(() => {
    vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "pat_test");
    vi.stubEnv("AIRTABLE_BASE_ID", "app_test");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips when LEGACY_RECURRING_INTROS_ENABLED=false", async () => {
    vi.stubEnv("LEGACY_RECURRING_INTROS_ENABLED", "false");
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/recurring-intros")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("legacy_recurring_intros_disabled");
    expect(runRecurringCityIntros).not.toHaveBeenCalled();
  });

  it("still runs when the gate is unset (current behaviour)", async () => {
    vi.stubEnv("LEGACY_RECURRING_INTROS_ENABLED", "");
    vi.mocked(runRecurringCityIntros).mockResolvedValue({
      success: true,
      sentGroups: 0,
      alreadySentGroups: 0,
      failedGroups: 0,
      partialSuccess: false,
    } as never);
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/recurring-intros")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.skipped).toBeUndefined();
    expect(runRecurringCityIntros).toHaveBeenCalledTimes(1);
  });
});
