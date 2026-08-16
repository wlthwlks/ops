import { and, eq, gte, isNull } from "drizzle-orm";
import type { AppDb } from "@/db";
import { matchEvents, matchEventMatches } from "@/db/schema";
import {
  getRecentIntroductionPairs,
  getRecentlyIntroducedEmails,
  mergePairMaps,
} from "./history";

/**
 * Repeat-pair and member-cooldown history for the unified introduction
 * engine. Combines the new introduction ledger (which includes the imported
 * Airtable match-group history) with the legacy first-introduction
 * match_events ledger so recent pairings are avoided across both systems.
 */

export function normalizeEmailKey(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function pairKeyForEmails(a: string, b: string): string {
  return [normalizeEmailKey(a), normalizeEmailKey(b)].sort().join("|");
}

export interface PairHistory {
  /** Sorted-email pair keys seen within the repeat window. */
  recentPairs: Set<string>;
  /** Lowercased member emails seen within the member-cooldown window. */
  recentMemberEmails: Set<string>;
}

export interface PairHistoryOptions {
  pairDays: number;
  memberDays: number;
  now?: Date;
}

function cutoffBefore(now: Date, days: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}

/**
 * Legacy first-introduction history: (new member, match) pairs and
 * participating emails from match_events/match_event_matches, excluding
 * dry-runs and soft-deleted events.
 */
async function loadLegacyMatchHistory(
  db: AppDb,
  opts: PairHistoryOptions
): Promise<{ pairs: Map<string, Set<string>>; emails: Set<string> }> {
  const now = opts.now ?? new Date();
  const pairs = new Map<string, Set<string>>();
  const emails = new Set<string>();

  const pairRows = await db
    .select({
      newMemberEmail: matchEvents.newMemberEmail,
      matchEmail: matchEventMatches.matchEmail,
    })
    .from(matchEvents)
    .innerJoin(matchEventMatches, eq(matchEventMatches.matchEventId, matchEvents.id))
    .where(
      and(
        eq(matchEvents.dryRun, false),
        isNull(matchEvents.deletedAt),
        gte(matchEvents.createdAt, cutoffBefore(now, opts.pairDays))
      )
    );

  for (const row of pairRows) {
    const a = normalizeEmailKey(row.newMemberEmail);
    const b = normalizeEmailKey(row.matchEmail);
    if (!a || !b) continue;
    pairs.set(pairKeyForEmails(a, b), new Set([a, b]));
  }

  const memberRows = await db
    .select({
      newMemberEmail: matchEvents.newMemberEmail,
      matchEmail: matchEventMatches.matchEmail,
    })
    .from(matchEvents)
    .innerJoin(matchEventMatches, eq(matchEventMatches.matchEventId, matchEvents.id))
    .where(
      and(
        eq(matchEvents.dryRun, false),
        isNull(matchEvents.deletedAt),
        gte(matchEvents.createdAt, cutoffBefore(now, opts.memberDays))
      )
    );

  for (const row of memberRows) {
    const a = normalizeEmailKey(row.newMemberEmail);
    const b = normalizeEmailKey(row.matchEmail);
    if (a) emails.add(a);
    if (b) emails.add(b);
  }

  return { pairs, emails };
}

export async function loadPairHistory(
  db: AppDb,
  opts: PairHistoryOptions
): Promise<PairHistory> {
  const [ledgerPairs, ledgerEmails, legacy] = await Promise.all([
    getRecentIntroductionPairs(db, opts.pairDays),
    getRecentlyIntroducedEmails(db, opts.memberDays),
    loadLegacyMatchHistory(db, opts),
  ]);

  const mergedPairs = mergePairMaps(ledgerPairs, legacy.pairs);
  const mergedEmails = new Set<string>(ledgerEmails);
  for (const email of legacy.emails) mergedEmails.add(email);

  return {
    recentPairs: new Set(mergedPairs.keys()),
    recentMemberEmails: mergedEmails,
  };
}

export function isPairRecent(
  history: PairHistory,
  emailA: string | null | undefined,
  emailB: string | null | undefined
): boolean {
  const a = normalizeEmailKey(emailA);
  const b = normalizeEmailKey(emailB);
  if (!a || !b) return false;
  return history.recentPairs.has(pairKeyForEmails(a, b));
}

export function isMemberRecent(
  history: PairHistory,
  email: string | null | undefined
): boolean {
  const key = normalizeEmailKey(email);
  if (!key) return false;
  return history.recentMemberEmails.has(key);
}
