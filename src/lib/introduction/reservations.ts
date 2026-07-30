import { eq, lt, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import { introductionReservations } from "@/db/schema/introduction-reservations";

function makeMemberKey(airtableRecordId?: string, email?: string): string | null {
  if (airtableRecordId) return `at:${airtableRecordId}`;
  if (email) return `em:${email.trim().toLowerCase()}`;
  return null;
}

/**
 * Delete all reservations that have passed their expires_at.
 */
export async function deleteExpiredReservations(db: AppDb): Promise<number> {
  const result = await db
    .delete(introductionReservations)
    .where(lt(introductionReservations.expiresAt, new Date()))
    .returning({ key: introductionReservations.memberKey });
  return result.length;
}

/**
 * Try to reserve members. Returns the member keys that were successfully
 * reserved and those that were already taken (conflicts).
 *
 * ON CONFLICT DO NOTHING means already-reserved members are silently
 * skipped. We then read back which keys actually exist to determine
 * conflicts.
 */
export async function reserveMembers(
  db: AppDb,
  groupId: string,
  source: "onboarding" | "recurring",
  members: Array<{ airtableRecordId?: string; email?: string }>,
  expiresAt: Date
): Promise<{ reserved: string[]; conflicts: string[] }> {
  const allKeys = members.map((m) => makeMemberKey(m.airtableRecordId, m.email)).filter(Boolean) as string[];

  if (allKeys.length === 0) return { reserved: [], conflicts: [] };

  // Insert reservations — ON CONFLICT DO NOTHING
  for (const key of allKeys) {
    await db
      .insert(introductionReservations)
      .values({
        memberKey: key,
        groupId,
        source,
        expiresAt,
      })
      .onConflictDoNothing();
  }

  // Read back which ones actually exist
  const existing = await db
    .select({ key: introductionReservations.memberKey, gid: introductionReservations.groupId })
    .from(introductionReservations)
    .where(inArray(introductionReservations.memberKey, allKeys));

  const reservedSet = new Set(existing.filter((r) => r.gid === groupId).map((r) => r.key));
  const reserved = allKeys.filter((k) => reservedSet.has(k));
  const conflicts = allKeys.filter((k) => !reservedSet.has(k));

  return { reserved, conflicts };
}

/**
 * Release reservations for a specific group.
 */
export async function releaseReservations(db: AppDb, groupId: string): Promise<number> {
  const result = await db
    .delete(introductionReservations)
    .where(eq(introductionReservations.groupId, groupId))
    .returning({ key: introductionReservations.memberKey });
  return result.length;
}

/**
 * Release reservations for all groups in a run by querying the group IDs.
 */
export async function releaseRunReservations(db: AppDb, groupIds: string[]): Promise<number> {
  let total = 0;
  for (const gid of groupIds) {
    total += await releaseReservations(db, gid);
  }
  return total;
}

/**
 * Check if any of the given members are currently reserved by another group.
 */
export async function findReservationConflicts(
  db: AppDb,
  members: Array<{ airtableRecordId?: string; email?: string }>,
  excludeGroupId?: string
): Promise<string[]> {
  const keys = members.map((m) => makeMemberKey(m.airtableRecordId, m.email)).filter(Boolean) as string[];
  if (keys.length === 0) return [];

  const rows = await db
    .select({ key: introductionReservations.memberKey, gid: introductionReservations.groupId })
    .from(introductionReservations)
    .where(inArray(introductionReservations.memberKey, keys));

  if (excludeGroupId) {
    return rows.filter((r) => r.gid !== excludeGroupId).map((r) => r.key);
  }
  return rows.map((r) => r.key);
}
