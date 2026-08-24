import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  cityNameFromRecord,
  countActiveMembersByCity,
  syncCitiesFromAirtable,
  syncCitiesIfStale,
  resetCitySyncTtl,
} from "@/lib/introduction/city-sync";
import { cityIntroductionSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const airtableList = vi.fn();

function makeAirtable(): AirtableClient {
  return {
    listRecords: (table: string, options?: unknown) => airtableList(table, options),
  } as unknown as AirtableClient;
}

function cityRecord(id: string, name: string): AirtableRecord {
  return { id, fields: { City: name } };
}

function memberRecord(id: string, fields: Record<string, unknown>): AirtableRecord {
  return { id, fields };
}

function mockTables(cities: AirtableRecord[], members: AirtableRecord[] = []) {
  airtableList.mockImplementation(async (table: string) => {
    if (table === "ALL CITIES") return cities;
    if (table === "MEMBERS") return members;
    return [];
  });
}

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetIntroductionsV2Tables(db);
  resetCitySyncTtl();
});

describe("cityNameFromRecord", () => {
  it("falls back across City/Name/name fields", () => {
    expect(cityNameFromRecord({ City: "London" })).toBe("London");
    expect(cityNameFromRecord({ Name: "Gold Coast" })).toBe("Gold Coast");
    expect(cityNameFromRecord({ name: "Brisbane" })).toBe("Brisbane");
    expect(cityNameFromRecord({})).toBeNull();
  });
});

describe("countActiveMembersByCity", () => {
  const cities = [cityRecord("rec_c1", "London"), cityRecord("rec_c2", "Gold Coast")];
  const reference = new Date("2026-08-24T12:00:00Z");

  it("counts service-access members via City relation and legacy City text", () => {
    const members = [
      memberRecord("m1", { Membership: "Active", Payment: "Paid", "City relation": ["rec_c1"] }),
      memberRecord("m2", { Membership: "Active", Payment: "Paid", City: "Gold Coast" }),
      memberRecord("m3", { Membership: "Active", Payment: "Paid", "City relation": ["rec_c1"] }),
    ];
    const counts = countActiveMembersByCity(cities, members, reference);
    expect(counts.get("rec_c1")).toBe(2);
    expect(counts.get("rec_c2")).toBe(1);
  });

  it("excludes members without service access", () => {
    const members = [
      memberRecord("m1", { Membership: "Active", Payment: "Paid", "City relation": ["rec_c1"] }),
      memberRecord("m2", { Membership: "Cancelled", Payment: "Paid", "City relation": ["rec_c1"] }),
      memberRecord("m3", { Membership: "Active", Payment: "Unpaid", City: "London" }),
      memberRecord("m4", { Membership: "", Payment: "", "Service access until": "2027-01-01", City: "London" }),
    ];
    const counts = countActiveMembersByCity(cities, members, reference);
    expect(counts.get("rec_c1")).toBe(2);
  });

  it("attributes members with an unknown link to their legacy city text", () => {
    const members = [
      memberRecord("m1", {
        Membership: "Active",
        Payment: "Paid",
        "City relation": ["rec_missing"],
        City: "London",
      }),
    ];
    const counts = countActiveMembersByCity(cities, members, reference);
    expect(counts.get("rec_c1")).toBe(1);
  });
});

describe("syncCitiesFromAirtable", () => {
  it("creates rows for new Airtable cities with disabled defaults", async () => {
    mockTables([cityRecord("rec_c1", "London"), cityRecord("rec_c2", "Gold Coast")]);

    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.created).toBe(2);
    expect(result.total).toBe(2);
    expect(result.stale).toBe(0);

    // Only the canonical "City" field is requested (ALL CITIES has no "Name").
    expect(airtableList).toHaveBeenCalledWith("ALL CITIES", { fields: ["City"] });

    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows).toHaveLength(2);
    const london = rows.find((r) => r.cityCode === "rec_c1")!;
    expect(london.cityName).toBe("London");
    expect(london.enabled).toBe(false);
    expect(london.activeMemberCount).toBe(0);
  });

  it("stores active-member counts from Airtable", async () => {
    mockTables(
      [cityRecord("rec_c1", "London"), cityRecord("rec_c2", "Brisbane")],
      [
        memberRecord("m1", { Membership: "Active", Payment: "Paid", "City relation": ["rec_c1"] }),
        memberRecord("m2", { Membership: "Active", Payment: "Paid", "City relation": ["rec_c1"] }),
        memberRecord("m3", { Membership: "Cancelled", Payment: "", City: "London" }),
        memberRecord("m4", { Membership: "Active", Payment: "Paid", City: "Brisbane" }),
      ]
    );

    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.created).toBe(2);
    expect(result.membersScanned).toBe(4);

    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows.find((r) => r.cityCode === "rec_c1")?.activeMemberCount).toBe(2);
    expect(rows.find((r) => r.cityCode === "rec_c2")?.activeMemberCount).toBe(1);
  });

  it("updates changed names but never touches admin configuration", async () => {
    mockTables([cityRecord("rec_c1", "London")]);
    await syncCitiesFromAirtable(db, makeAirtable());

    // Admin configures the city…
    await db
      .update(cityIntroductionSettings)
      .set({ enabled: true, minEligibleMembers: 5, repeatPairDays: 90 })
      .where(eq(cityIntroductionSettings.cityCode, "rec_c1"));

    // …Airtable renames the city.
    mockTables([cityRecord("rec_c1", "Greater London")]);
    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.nameUpdated).toBe(1);

    const row = await db
      .select()
      .from(cityIntroductionSettings)
      .where(eq(cityIntroductionSettings.cityCode, "rec_c1"));
    expect(row[0].cityName).toBe("Greater London");
    expect(row[0].enabled).toBe(true);
    expect(row[0].minEligibleMembers).toBe(5);
    expect(row[0].repeatPairDays).toBe(90);
  });

  it("updates only the member count when it changes", async () => {
    mockTables(
      [cityRecord("rec_c1", "London")],
      [memberRecord("m1", { Membership: "Active", Payment: "Paid", City: "London" })]
    );
    await syncCitiesFromAirtable(db, makeAirtable());

    await db
      .update(cityIntroductionSettings)
      .set({ enabled: true })
      .where(eq(cityIntroductionSettings.cityCode, "rec_c1"));

    mockTables(
      [cityRecord("rec_c1", "London")],
      [
        memberRecord("m1", { Membership: "Active", Payment: "Paid", City: "London" }),
        memberRecord("m2", { Membership: "Active", Payment: "Paid", City: "London" }),
      ]
    );
    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.countsUpdated).toBe(1);
    expect(result.nameUpdated).toBe(0);

    const row = await db
      .select()
      .from(cityIntroductionSettings)
      .where(eq(cityIntroductionSettings.cityCode, "rec_c1"));
    expect(row[0].activeMemberCount).toBe(2);
    expect(row[0].enabled).toBe(true);
  });

  it("continues the city sync when the members fetch fails", async () => {
    airtableList.mockImplementation(async (table: string) => {
      if (table === "ALL CITIES") return [cityRecord("rec_c1", "London")];
      throw new Error("boom");
    });

    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.created).toBe(1);
    expect(result.membersScanned).toBe(0);

    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows[0].activeMemberCount).toBeNull();
  });

  it("is idempotent and reports stale rows without deleting them", async () => {
    mockTables([cityRecord("rec_c1", "London"), cityRecord("rec_c2", "Brisbane")]);
    await syncCitiesFromAirtable(db, makeAirtable());

    // rec_c2 disappears from Airtable.
    mockTables([cityRecord("rec_c1", "London")]);
    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.unchanged).toBe(1);
    expect(result.created).toBe(0);
    expect(result.stale).toBe(1);

    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows).toHaveLength(2); // stale row preserved
  });

  it("creates rows with a null name for nameless Airtable cities", async () => {
    mockTables([cityRecord("rec_blank", "")]);
    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.created).toBe(1);
    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows[0].cityName).toBeNull();
  });
});

describe("syncCitiesIfStale", () => {
  it("syncs once per TTL window", async () => {
    mockTables([cityRecord("rec_c1", "London")]);
    const first = await syncCitiesIfStale(db, makeAirtable());
    expect(first?.created).toBe(1);

    const second = await syncCitiesIfStale(db, makeAirtable());
    expect(second).toBeNull();
    expect(airtableList).toHaveBeenCalledTimes(2); // ALL CITIES + MEMBERS
  });

  it("syncs again after the TTL is reset", async () => {
    mockTables([cityRecord("rec_c1", "London")]);
    await syncCitiesIfStale(db, makeAirtable());
    resetCitySyncTtl();
    const again = await syncCitiesIfStale(db, makeAirtable());
    expect(again).not.toBeNull();
    expect(airtableList).toHaveBeenCalledTimes(4);
  });
});
