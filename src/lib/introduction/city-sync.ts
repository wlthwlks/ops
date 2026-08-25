import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import { cityIntroductionSettings } from "@/db/schema";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  CITIES_TABLE,
  MEMBERS_TABLE,
  MEMBER_FIELDS,
  toAirtableSchemaError,
} from "@/lib/ops/airtable-fields";
import { fieldStr, linkedRecordIds } from "@/lib/ops/city-relation-repair";
import { hasServiceAccess } from "./service-access";

/**
 * Keeps city_introduction_settings synchronized with the Airtable ALL CITIES
 * table. The city code IS the Airtable record id (the app-wide convention,
 * also used by the onboarding catalog), so no "City Code" field is needed
 * in Airtable.
 *
 * Sync semantics:
 *  - New Airtable cities → insert a settings row (disabled, defaults).
 *  - Existing rows → only the city name and the active-member count are
 *    updated; admin configuration (enabled, overrides, schedule,
 *    auto-approve) is never touched.
 *  - DB rows whose record id no longer exists in Airtable are reported as
 *    `stale` but never deleted (they may hold history and configuration).
 *
 * Active-member counts: a member counts for a city iff hasServiceAccess
 * passes AND their City relation links to that city's ALL CITIES record.
 * City text is never used for membership.
 */

export interface CitySyncResult {
  created: number;
  nameUpdated: number;
  unchanged: number;
  /** Rows in the DB whose Airtable record no longer exists. */
  stale: number;
  /** Total Airtable cities processed. */
  total: number;
  /** Airtable MEMBERS records scanned for active-member counts. */
  membersScanned: number;
  /** City rows whose active-member count changed. */
  countsUpdated: number;
}

export function cityNameFromRecord(fields: Record<string, unknown>): string | null {
  const name = String(fields["City"] ?? fields["Name"] ?? fields["name"] ?? "").trim();
  return name || null;
}

const MEMBER_COUNT_FIELDS = [
  MEMBER_FIELDS.membership,
  MEMBER_FIELDS.payment,
  MEMBER_FIELDS.serviceAccessUntil,
  MEMBER_FIELDS.cityRelation,
];

/** Load MEMBERS for counting; requires a "City relation" field. */
async function loadMemberRecords(
  airtable: AirtableClient,
  log: (message: string) => void
): Promise<AirtableRecord[] | null> {
  try {
    return await airtable.listRecords(MEMBERS_TABLE, { fields: MEMBER_COUNT_FIELDS });
  } catch (e) {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    if (schema?.field === MEMBER_FIELDS.cityRelation) {
      log(
        `Active-member counts skipped: MEMBERS has no "City relation" field`
      );
      return null;
    }
    log(
      `Active-member counts skipped: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/**
 * Count members with service access per city record id. Membership is
 * determined ONLY by the City relation link to the city's ALL CITIES
 * record — city text is never used, so members cannot leak across cities.
 */
export function countActiveMembersByCity(
  cityRecords: AirtableRecord[],
  memberRecords: AirtableRecord[],
  referenceDate: Date = new Date()
): Map<string, number> {
  const cityCodes = new Set(cityRecords.map((r) => r.id));
  const counts = new Map<string, number>();

  for (const r of memberRecords) {
    const membership = fieldStr(r.fields, MEMBER_FIELDS.membership);
    const payment = fieldStr(r.fields, MEMBER_FIELDS.payment);
    const until = fieldStr(r.fields, MEMBER_FIELDS.serviceAccessUntil) || null;
    if (!hasServiceAccess(membership, payment, until, referenceDate)) continue;

    let cityCode: string | null = null;
    for (const id of linkedRecordIds(r.fields, MEMBER_FIELDS.cityRelation)) {
      if (cityCodes.has(id)) {
        cityCode = id;
        break;
      }
    }
    if (!cityCode) continue;

    counts.set(cityCode, (counts.get(cityCode) ?? 0) + 1);
  }
  return counts;
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

  const memberRecords = await loadMemberRecords(airtable, log);
  const countsByCityCode = memberRecords
    ? countActiveMembersByCity(records, memberRecords)
    : null;

  const existingRows = await db.select().from(cityIntroductionSettings);
  const existingByCode = new Map(existingRows.map((row) => [row.cityCode, row]));

  let created = 0;
  let nameUpdated = 0;
  let unchanged = 0;
  let countsUpdated = 0;

  for (const [cityCode, name] of incoming) {
    const count = countsByCityCode?.get(cityCode) ?? 0;
    const existing = existingByCode.get(cityCode);
    if (!existing) {
      await db.insert(cityIntroductionSettings).values({
        id: crypto.randomUUID(),
        cityCode,
        cityName: name,
        ...(countsByCityCode ? { activeMemberCount: count } : {}),
      });
      created += 1;
      continue;
    }
    if (name !== null && existing.cityName !== name) {
      await db
        .update(cityIntroductionSettings)
        .set({
          cityName: name,
          updatedAt: new Date(),
          ...(countsByCityCode ? { activeMemberCount: count } : {}),
        })
        .where(eq(cityIntroductionSettings.cityCode, cityCode));
      nameUpdated += 1;
      continue;
    }
    if (countsByCityCode && existing.activeMemberCount !== count) {
      await db
        .update(cityIntroductionSettings)
        .set({ activeMemberCount: count, updatedAt: new Date() })
        .where(eq(cityIntroductionSettings.cityCode, cityCode));
      countsUpdated += 1;
      continue;
    }
    unchanged += 1;
  }

  const stale = existingRows.filter((row) => !incoming.has(row.cityCode)).length;

  log(
    `City sync: ${created} created, ${nameUpdated} name-updated, ${unchanged} unchanged, ` +
      `${stale} stale, ${countsUpdated} count-updated (${memberRecords?.length ?? 0} members scanned)`
  );
  return {
    created,
    nameUpdated,
    unchanged,
    stale,
    total: incoming.size,
    membersScanned: memberRecords?.length ?? 0,
    countsUpdated,
  };
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
