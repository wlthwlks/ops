/**
 * Reconcile keys for the SweatPals gating job.
 *
 * The reconcile job iterates members that have SweatPals linkage (rows in
 * `sweatpals_memberships`), re-fetches their membership state from the
 * SweatPals external API and mirrors it to Airtable. Keys are deduped by
 * lookup identity (email preferred, then phone), oldest sync first.
 */
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { sweatpalsMemberships } from "@/db/schema";

export type SweatpalsReconcileKey = {
  memberId: string | null;
  email: string | null;
  phone: string | null;
  lastSyncedAt: Date | null;
};

export async function listSweatpalsReconcileKeys(
  opts: { limit?: number } = {}
): Promise<SweatpalsReconcileKey[]> {
  const rows = await db
    .select({
      memberId: sweatpalsMemberships.memberId,
      email: sweatpalsMemberships.sweatpalsEmail,
      phone: sweatpalsMemberships.sweatpalsPhone,
      lastSyncedAt: sweatpalsMemberships.lastSyncedAt,
    })
    .from(sweatpalsMemberships)
    .orderBy(asc(sweatpalsMemberships.lastSyncedAt))
    .limit(opts.limit ?? 1000);

  const byEmail = new Map<string, SweatpalsReconcileKey>();
  const byPhone = new Map<string, SweatpalsReconcileKey>();
  for (const r of rows) {
    const key: SweatpalsReconcileKey = {
      memberId: r.memberId,
      email: r.email,
      phone: r.phone,
      lastSyncedAt: r.lastSyncedAt,
    };
    if (r.email) {
      const prev = byEmail.get(r.email);
      // Prefer the row that carries the member linkage.
      if (!prev || (!prev.memberId && r.memberId)) byEmail.set(r.email, key);
    } else if (r.phone) {
      const prev = byPhone.get(r.phone);
      if (!prev || (!prev.memberId && r.memberId)) byPhone.set(r.phone, key);
    }
  }
  return [...byEmail.values(), ...byPhone.values()];
}
