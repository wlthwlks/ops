import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import { cityIntroductionSettings } from "@/db/schema";
import type { AirtableClient } from "@/lib/integrations/airtable";
import { CITIES_TABLE } from "@/lib/ops/airtable-fields";

/**
 * Keeps city_introduction_settings synchronized with the Airtable ALL CITIES
 * table. The city code IS the Airtable record id (the app-wide convention,
 * also used by the onboarding catalog), so no "City Code" field is needed
 * in Airtable.
 *
 * Sync semantics:
 *  - New Airtable cities → insert a settings row (disabled, defaults).
 *  - Existing rows → only the city name is updated; admin configuration
 *    (enabled, overrides, schedule, auto-approve) is never touched.
 *  - DB rows whose record id no longer exists in Airtable are reported as
 *    `stale` but never deleted (they may hold history and configuration).
 */

export interface CitySyncResult {
  created: number;
  nameUpdated: number;
  unchanged: number;
  /** Rows in the DB whose Airtable record no longer exists. */
  stale: number;
  /** Total Airtable cities processed. */
  total: number;
}

export function cityNameFromRecord(fields: Record<string, unknown>): string | null {
  const name = String(fields["City"] ?? fields["Name"] ?? fields["name"] ?? "").trim();
  return name || null;
}

export async function syncCitiesFromAirtable(
  db: AppDb,
  airtable: AirtableClient,
  log: (message: string) => void = () => {}
): Promise<CitySyncResult> {
  // ALL CITIES has no "Name" field — requesting unknown fields makes
  // Airtable reject the entire request with 422 UNKNOWN_FIELD_NAME.
  const records = await airtable.listRecords(CITIES_TABLE, {
    fields: ["City"],
  });

  const incoming = new Map<string, string | null>();
  for (const record of records) {
    incoming.set(record.id, cityNameFromRecord(record.fields));
  }

  const existingRows = await db.select().from(cityIntroductionSettings);
  const existingByCode = new Map(existingRows.map((row) => [row.cityCode, row]));

  let created = 0;
  let nameUpdated = 0;
  let unchanged = 0;

  for (const [cityCode, name] of incoming) {
    const existing = existingByCode.get(cityCode);
    if (!existing) {
      await db.insert(cityIntroductionSettings).values({
        id: crypto.randomUUID(),
        cityCode,
        cityName: name,
      });
      created += 1;
      continue;
    }
    if (name !== null && existing.cityName !== name) {
      await db
        .update(cityIntroductionSettings)
        .set({ cityName: name, updatedAt: new Date() })
        .where(eq(cityIntroductionSettings.cityCode, cityCode));
      nameUpdated += 1;
      continue;
    }
    unchanged += 1;
  }

  const stale = existingRows.filter((row) => !incoming.has(row.cityCode)).length;

  log(
    `City sync: ${created} created, ${nameUpdated} name-updated, ${unchanged} unchanged, ${stale} stale`
  );
  return { created, nameUpdated, unchanged, stale, total: incoming.size };
}

const READ_THROUGH_TTL_MS = 5 * 60 * 1000;
let lastReadThroughSyncAt = 0;

/**
 * Read-through sync for the cities list endpoints: performs the Airtable
 * sync at most once every five minutes so the Ops UI stays fresh without a
 * dedicated cron job. Returns null when the TTL skipped the sync.
 */
export async function syncCitiesIfStale(
  db: AppDb,
  airtable: AirtableClient,
  log?: (message: string) => void
): Promise<CitySyncResult | null> {
  if (Date.now() - lastReadThroughSyncAt < READ_THROUGH_TTL_MS) return null;
  lastReadThroughSyncAt = Date.now();
  return syncCitiesFromAirtable(db, airtable, log);
}

/** Test helper: reset the read-through TTL so tests always run the sync. */
export function resetCitySyncTtl(): void {
  lastReadThroughSyncAt = 0;
}
