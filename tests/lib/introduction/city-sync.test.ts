import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  cityNameFromRecord,
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
  return { listRecords: airtableList } as unknown as AirtableClient;
}

function cityRecord(id: string, name: string): AirtableRecord {
  return { id, fields: { City: name } };
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

describe("syncCitiesFromAirtable", () => {
  it("creates rows for new Airtable cities with disabled defaults", async () => {
    airtableList.mockResolvedValue([cityRecord("rec_c1", "London"), cityRecord("rec_c2", "Gold Coast")]);

    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.created).toBe(2);
    expect(result.total).toBe(2);
    expect(result.stale).toBe(0);

    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows).toHaveLength(2);
    const london = rows.find((r) => r.cityCode === "rec_c1")!;
    expect(london.cityName).toBe("London");
    expect(london.enabled).toBe(false);
  });

  it("updates changed names but never touches admin configuration", async () => {
    airtableList.mockResolvedValue([cityRecord("rec_c1", "London")]);
    await syncCitiesFromAirtable(db, makeAirtable());

    // Admin configures the city…
    await db
      .update(cityIntroductionSettings)
      .set({ enabled: true, minEligibleMembers: 5, repeatPairDays: 90 })
      .where(eq(cityIntroductionSettings.cityCode, "rec_c1"));

    // …Airtable renames the city.
    airtableList.mockResolvedValue([cityRecord("rec_c1", "Greater London")]);
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

  it("is idempotent and reports stale rows without deleting them", async () => {
    airtableList.mockResolvedValue([cityRecord("rec_c1", "London"), cityRecord("rec_c2", "Brisbane")]);
    await syncCitiesFromAirtable(db, makeAirtable());

    // rec_c2 disappears from Airtable.
    airtableList.mockResolvedValue([cityRecord("rec_c1", "London")]);
    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.unchanged).toBe(1);
    expect(result.created).toBe(0);
    expect(result.stale).toBe(1);

    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows).toHaveLength(2); // stale row preserved
  });

  it("creates rows with a null name for nameless Airtable cities", async () => {
    airtableList.mockResolvedValue([cityRecord("rec_blank", "")]);
    const result = await syncCitiesFromAirtable(db, makeAirtable());
    expect(result.created).toBe(1);
    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows[0].cityName).toBeNull();
  });
});

describe("syncCitiesIfStale", () => {
  it("syncs once per TTL window", async () => {
    airtableList.mockResolvedValue([cityRecord("rec_c1", "London")]);
    const first = await syncCitiesIfStale(db, makeAirtable());
    expect(first?.created).toBe(1);

    const second = await syncCitiesIfStale(db, makeAirtable());
    expect(second).toBeNull();
    expect(airtableList).toHaveBeenCalledTimes(1);
  });

  it("syncs again after the TTL is reset", async () => {
    airtableList.mockResolvedValue([cityRecord("rec_c1", "London")]);
    await syncCitiesIfStale(db, makeAirtable());
    resetCitySyncTtl();
    const again = await syncCitiesIfStale(db, makeAirtable());
    expect(again).not.toBeNull();
    expect(airtableList).toHaveBeenCalledTimes(2);
  });
});
