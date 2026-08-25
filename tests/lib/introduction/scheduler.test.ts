import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  computeNextRunAt,
  listDueCities,
  cycleIdExists,
  runCityIntroductionScheduler,
  parseCitySchedule,
  type CitySchedulerDeps,
} from "@/lib/introduction/scheduler";
import { upsertCitySettings } from "@/lib/introduction/settings";
import { createMatchingProfile, createMatchingProfileVersion } from "@/lib/introduction/profiles";
import {
  cityIntroductionSettings,
  introductionRuns,
  introductionGroups,
  introductionDeliveries,
} from "@/db/schema";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { PineconeClient, VectorRecord } from "@/lib/integrations/pinecone";

vi.mock("@/lib/geo/geocode", () => ({
  geocode: vi.fn(async (postcode: string) => ({
    lat: 51.5 + postcode.length * 0.001,
    lon: -0.12 + postcode.length * 0.001,
    displayName: `${postcode}, London, UK`,
  })),
  extractOutcode: (value: string) => value,
}));

const syncPineconeBeforePlan = vi.fn(async () => ({ success: true, summary: "sync ok" }));

vi.mock("@/lib/introduction/preplan-sync", () => ({
  syncPineconeBeforePlan: () => syncPineconeBeforePlan(),
}));

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const airtableList = vi.fn();
const airtableGetRecord = vi.fn();
const pineconeFetch = vi.fn();

function makeDeps(live = true): CitySchedulerDeps {
  return {
    db,
    log: () => {},
    airtable: {
      listRecords: airtableList,
      getRecord: airtableGetRecord,
    } as unknown as AirtableClient,
    pinecone: { fetchByIds: pineconeFetch } as unknown as PineconeClient,
    now: new Date("2026-08-16T09:00:00Z"),
    live,
  };
}

function memberRecord(id: string): AirtableRecord {
  return {
    id,
    fields: {
      email: `${id.replace(/^rec_/, "")}@example.com`,
      Name: `Name ${id}`,
      "First Name": "First",
      "Last Name": "Last",
      City: "London",
      "City relation": ["rec_london"],
      "post code": "SW1A 1AA",
      Membership: "Active",
      Payment: "Paid",
      "Service access until": "",
      "Recurring intro status": "",
      "Recurring pause until": "",
      Industry: "TECH_SAAS",
      "Business stage": "EARLY_TRACTION",
      "Connection type": ["SIMILAR_STAGE_PEER"],
      "Professional Headline": "Headline",
      "Current 90-day goal": "Goal",
      "Help wanted": ["FUNDRAISING"],
      "Help wanted context": "Context",
      Expertise: ["GROWTH_MARKETING"],
      "Expertise context": "Context",
    },
  };
}

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true, matchmake: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetIntroductionsV2Tables(db);
  await db.delete(await import("@/db/schema").then((m) => m.matchEventMatches));
  await db.delete(await import("@/db/schema").then((m) => m.matchEvents));
  airtableGetRecord.mockResolvedValue({ id: "rec_city_london", fields: { City: "London" } });
  airtableList.mockImplementation(async (table: string) => {
    if (table === "MATCHING OPTIONS") return [];
    if (table === "ALL CITIES") return [];
    return [memberRecord("rec_a"), memberRecord("rec_b"), memberRecord("rec_c"), memberRecord("rec_d")];
  });
  pineconeFetch.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, VectorRecord>();
    for (const id of ids) map.set(id, { id, values: [1, 0, 0], metadata: {} });
    return map;
  });
});

const SCHEDULE = { dayOfMonth: 1, localTime: "09:00", timezone: "Europe/London" };

describe("computeNextRunAt", () => {
  it("returns the same month when the day/time is still ahead", () => {
    const after = new Date("2026-08-16T08:00:00Z");
    const next = computeNextRunAt(SCHEDULE, after);
    expect(next.toISOString()).toBe("2026-09-01T08:00:00.000Z");
  });

  it("rolls to the next month when the instant has passed", () => {
    const after = new Date("2026-08-16T09:30:00Z");
    const next = computeNextRunAt(SCHEDULE, after);
    expect(next.toISOString()).toBe("2026-09-01T08:00:00.000Z");
  });

  it("clamps oversized day-of-month values", () => {
    const next = computeNextRunAt({ dayOfMonth: 31, localTime: "09:00", timezone: "UTC" }, new Date("2026-02-01T00:00:00Z"));
    expect(next.toISOString().slice(0, 10)).toBe("2026-02-28");
  });
});

describe("isCityDue / listDueCities", () => {
  it("requires enabled + scheduled + due next_run_at", async () => {
    await upsertCitySettings(db, "rec_c1", {
      cityName: "C1",
      enabled: true,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify(SCHEDULE),
      nextRunAt: "2026-08-15T00:00:00Z",
    });
    await upsertCitySettings(db, "rec_c2", {
      cityName: "C2",
      enabled: true,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify(SCHEDULE),
      nextRunAt: "2026-09-01T00:00:00Z",
    });
    await upsertCitySettings(db, "rec_c3", {
      cityName: "C3",
      enabled: false,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify(SCHEDULE),
      nextRunAt: "2026-08-15T00:00:00Z",
    });
    await upsertCitySettings(db, "rec_c4", {
      cityName: "C4",
      enabled: true,
      schedulingMode: "manual",
      nextRunAt: "2026-08-15T00:00:00Z",
    });
    // No nextRunAt → due (first run initializes the schedule).
    await upsertCitySettings(db, "rec_c5", {
      cityName: "C5",
      enabled: true,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify(SCHEDULE),
    });

    const due = await listDueCities(db, new Date("2026-08-16T09:00:00Z"));
    expect(due.map((c) => c.cityCode).sort()).toEqual(["rec_c1", "rec_c5"]);
  });
});

describe("parseCitySchedule", () => {
  it("parses valid schedules and rejects garbage", async () => {
    await upsertCitySettings(db, "rec_s1", {
      cityName: "S1",
      scheduleJson: JSON.stringify(SCHEDULE),
    });
    // Insert an invalid schedule directly — the input validation would
    // reject it, but old rows could still carry garbage.
    await db.insert(cityIntroductionSettings).values({
      id: "s2-row",
      cityCode: "rec_s2",
      cityName: "S2",
      scheduleJson: JSON.stringify({ dayOfMonth: 99 }),
    });
    const rows = await db.select().from(cityIntroductionSettings);
    expect(parseCitySchedule(rows.find((r) => r.cityCode === "rec_s1")!)).toEqual(SCHEDULE);
    expect(parseCitySchedule(rows.find((r) => r.cityCode === "rec_s2")!)).toBeNull();
  });
});

describe("runCityIntroductionScheduler", () => {
  async function seedDueCity(opts: {
    code?: string;
    autoApprove?: boolean;
    autoMode?: "simulation" | "provider_test" | "canary" | "production";
  } = {}) {
    await upsertCitySettings(db, opts.code ?? "rec_london", {
      cityName: "London",
      enabled: true,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify(SCHEDULE),
      nextRunAt: "2026-08-15T00:00:00Z",
      autoApprove: opts.autoApprove ?? false,
      autoApproveDeliveryMode: opts.autoMode ?? "simulation",
    });
  }

  it("builds a preview for a due city and advances next_run_at", async () => {
    await seedDueCity();
    const result = await runCityIntroductionScheduler(makeDeps(true));
    expect(result.dueCities).toBe(1);
    expect(result.results[0].outcome).toBe("previewed");
    expect(result.results[0].runId).not.toBeNull();
    expect(result.results[0].nextRunAt).toBe("2026-09-01T08:00:00.000Z");

    const runs = await db.select().from(introductionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("planned");

    const city = await db.select().from(cityIntroductionSettings);
    expect(new Date(city[0].nextRunAt!).toISOString()).toBe("2026-09-01T08:00:00.000Z");
  });

  it("freezes when auto-approve is enabled with the configured mode", async () => {
    await seedDueCity({ autoApprove: true, autoMode: "simulation" });
    const result = await runCityIntroductionScheduler(makeDeps(true));
    expect(result.results[0].outcome).toBe("approved");

    const runs = await db.select().from(introductionRuns);
    expect(runs[0].status).toBe("approved");
    expect(runs[0].deliveryMode).toBe("simulation");
    const deliveries = await db.select().from(introductionDeliveries);
    expect(deliveries.length).toBeGreaterThan(0);
  });

  it("skips duplicate cycles idempotently", async () => {
    await seedDueCity();
    await runCityIntroductionScheduler(makeDeps(true));

    // Reset next_run_at into the past to make the city due again on the same day.
    await upsertCitySettings(db, "rec_london", { nextRunAt: "2026-08-15T00:00:00Z" });
    const second = await runCityIntroductionScheduler(makeDeps(true));
    expect(second.results[0].outcome).toBe("skipped_duplicate");
    const runs = await db.select().from(introductionRuns);
    expect(runs).toHaveLength(1);
  });

  it("never freezes production auto-approval in read-only mode", async () => {
    await seedDueCity({ autoApprove: true, autoMode: "production" });
    const result = await runCityIntroductionScheduler(makeDeps(false));
    expect(result.results[0].outcome).toBe("skipped_no_auto_approve_freeze");

    const runs = await db.select().from(introductionRuns);
    expect(runs[0].status).toBe("planned");
    expect(runs[0].deliveryMode).toBe("simulation");
  });

  it("freezes production auto-approval in live mode", async () => {
    await seedDueCity({ autoApprove: true, autoMode: "production" });
    const result = await runCityIntroductionScheduler(makeDeps(true));
    expect(result.results[0].outcome).toBe("approved");
    const runs = await db.select().from(introductionRuns);
    expect(runs[0].deliveryMode).toBe("production");
  });

  it("does not advance the schedule when the freeze fails", async () => {
    // Canary auto-approve with no canary addresses configured → freeze fails.
    await seedDueCity({ autoApprove: true, autoMode: "canary" });
    const result = await runCityIntroductionScheduler(makeDeps(true));
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].nextRunAt).toBeNull();

    const city = await db.select().from(cityIntroductionSettings);
    expect(new Date(city[0].nextRunAt!).toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("marks below-minimum cities as blocked and advances the schedule", async () => {
    const profile = await createMatchingProfile(db, { name: "Gate", isDefault: true });
    await createMatchingProfileVersion(db, {
      profileId: profile.id,
      constraints: {
        requireSameCity: true,
        maxDistanceKm: null,
        allowUnknownPostcode: true,
        repeatPairDays: 60,
        memberCooldownDays: 14,
        minEligibleMembers: 99,
        targetGroupSize: 3,
        minGroupSize: 2,
        maxGroupSize: 6,
        strictGroupSize: false,
      },
    });
    await seedDueCity();

    const result = await runCityIntroductionScheduler(makeDeps(true));
    expect(result.results[0].outcome).toBe("blocked");
    expect(result.results[0].nextRunAt).toBe("2026-09-01T08:00:00.000Z");

    const runs = await db.select().from(introductionRuns);
    expect(runs[0].status).toBe("blocked");
    const deliveries = await db.select().from(introductionDeliveries);
    expect(deliveries).toHaveLength(0);
  });

  it("runs the pre-plan Pinecone sync once per tick, not per city", async () => {
    await upsertCitySettings(db, "rec_london", {
      cityName: "London",
      enabled: true,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify(SCHEDULE),
      nextRunAt: "2026-08-15T00:00:00Z",
    });
    await upsertCitySettings(db, "rec_paris", {
      cityName: "Paris",
      enabled: true,
      schedulingMode: "scheduled",
      scheduleJson: JSON.stringify(SCHEDULE),
      nextRunAt: "2026-08-15T00:00:00Z",
    });

    syncPineconeBeforePlan.mockResolvedValue({ success: true, summary: "sync ok" });
    const result = await runCityIntroductionScheduler(makeDeps(true));
    expect(result.dueCities).toBe(2);
    expect(syncPineconeBeforePlan).toHaveBeenCalledTimes(1);
  });

  it("aborts the whole tick when the pre-plan sync fails and leaves cities due", async () => {
    await seedDueCity();
    syncPineconeBeforePlan.mockResolvedValue({
      success: false,
      summary: "embedding failed — openai down",
    });

    const result = await runCityIntroductionScheduler(makeDeps(true));
    expect(result.dueCities).toBe(1);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].error).toContain("Pre-plan Pinecone sync failed");
    expect(result.results[0].nextRunAt).toBeNull();

    // No plan was built and the schedule was not advanced.
    const runs = await db.select().from(introductionRuns);
    expect(runs).toHaveLength(0);
    const city = await db.select().from(cityIntroductionSettings);
    expect(new Date(city[0].nextRunAt!).toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("cycleIdExists", () => {
  it("detects existing cycles from group rows", async () => {
    await db.insert(introductionRuns).values({
      id: "r1",
      requestId: "req-1",
      source: "city",
      mode: "preview",
      dryRun: true,
      status: "planned",
    });
    await db.insert(introductionGroups).values({
      id: "g1",
      runId: "r1",
      source: "city",
      cycleId: "intro-rec_x-2026-08-16",
      groupFingerprint: "fp",
      status: "planned",
    });
    expect(await cycleIdExists(db, "intro-rec_x-2026-08-16")).toBe(true);
    expect(await cycleIdExists(db, "intro-rec_x-2026-08-17")).toBe(false);
  });
});
