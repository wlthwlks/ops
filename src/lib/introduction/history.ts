import { and, gte, eq, or, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import { introductionGroupMembers, introductionGroups } from "@/db/schema";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Returns the set of lowercased emails of every member who participated in
 * a successful introduction (sent or sent_tracking_failed) within the
 * cooldown window — including both recurring and onboarding sources.
 *
 * This covers the Postgres ledger. Airtable Match-groups are queried
 * separately by the orchestrator for backwards compatibility.
 */
export async function getRecentlyIntroducedEmails(
  db: AppDb,
  windowDays: number
): Promise<Set<string>> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const rows = await db
    .select({ email: introductionGroupMembers.emailSnapshot })
    .from(introductionGroupMembers)
    .innerJoin(
      introductionGroups,
      eq(introductionGroupMembers.groupId, introductionGroups.id)
    )
    .where(
      and(
        gte(introductionGroups.createdAt, cutoff),
        or(
          eq(introductionGroups.status, "sent"),
          eq(introductionGroups.status, "sent_tracking_failed")
        )
      )
    );

  const emails = new Set<string>();
  for (const r of rows) {
    if (r.email) emails.add(normalizeEmail(r.email));
  }
  return emails;
}

/**
 * Returns a map of all recent pairings: pair-key (sorted emails joined by "|")
 * → set of emails in the pair.
 */
export async function getRecentIntroductionPairs(
  db: AppDb,
  windowDays: number
): Promise<Map<string, Set<string>>> {
  const pairs = new Map<string, Set<string>>();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  // Group members by groupId
  const rows = await db
    .select({
      groupId: introductionGroupMembers.groupId,
      email: introductionGroupMembers.emailSnapshot,
    })
    .from(introductionGroupMembers)
    .innerJoin(
      introductionGroups,
      eq(introductionGroupMembers.groupId, introductionGroups.id)
    )
    .where(
      and(
        gte(introductionGroups.createdAt, cutoff),
        or(
          eq(introductionGroups.status, "sent"),
          eq(introductionGroups.status, "sent_tracking_failed")
        )
      )
    );

  // Build email list per group
  const groupEmails = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.email) continue;
    const email = normalizeEmail(r.email);
    const existing = groupEmails.get(r.groupId) || [];
    existing.push(email);
    groupEmails.set(r.groupId, existing);
  }

  // Build pair keys from each group's member list
  for (const emails of groupEmails.values()) {
    for (let i = 0; i < emails.length; i++) {
      for (let j = i + 1; j < emails.length; j++) {
        const pairKey = [emails[i], emails[j]].sort().join("|");
        pairs.set(pairKey, new Set([emails[i], emails[j]]));
      }
    }
  }

  return pairs;
}

/**
 * Returns stats per email: count of successful introductions.
 */
export async function getMemberIntroductionStats(
  db: AppDb,
  emails: string[]
): Promise<Map<string, number>> {
  const stats = new Map<string, number>();
  if (emails.length === 0) return stats;

  const normalized = emails.map(normalizeEmail);

  const rows = await db
    .select({ email: introductionGroupMembers.emailSnapshot })
    .from(introductionGroupMembers)
    .innerJoin(
      introductionGroups,
      eq(introductionGroupMembers.groupId, introductionGroups.id)
    )
    .where(
      and(
        inArray(introductionGroupMembers.emailSnapshot, normalized),
        or(
          eq(introductionGroups.status, "sent"),
          eq(introductionGroups.status, "sent_tracking_failed")
        )
      )
    );

  for (const r of rows) {
    if (!r.email) continue;
    const e = normalizeEmail(r.email);
    stats.set(e, (stats.get(e) || 0) + 1);
  }

  // Ensure all input emails have an entry (even zero)
  for (const e of normalized) {
    if (!stats.has(e)) stats.set(e, 0);
  }

  return stats;
}

/**
 * Merges two pair-maps. Each map has pairKey → Set<email>.
 */
export function mergePairMaps(
  a: Map<string, Set<string>>,
  b: Map<string, Set<string>>
): Map<string, Set<string>> {
  const merged = new Map(a);
  for (const [key, set] of b) {
    if (merged.has(key)) {
      const existing = merged.get(key)!;
      for (const e of set) existing.add(e);
    } else {
      merged.set(key, new Set(set));
    }
  }
  return merged;
}
