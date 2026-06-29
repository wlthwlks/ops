/**
 * Minimal shape the selector needs from a Pinecone candidate — an id plus a
 * metadata bag that carries the member's email. Kept structural so the engine
 * can pass its raw query results straight through.
 */
export interface FreshMatchCandidate {
  id: string;
  metadata: Record<string, unknown>;
}

export interface SelectFreshMatchesOptions {
  /** The new member's own Pinecone id — never matched to themselves. */
  memberId: string;
  /** Lowercased emails locked by the rolling 30-day rule. */
  recentlyMatched: ReadonlySet<string>;
  /** Lowercased emails already used as a match earlier in this batch. */
  usedInBatch: ReadonlySet<string>;
  /** How many fresh matches to aim for. */
  target: number;
}

export interface SelectFreshMatchesResult<T> {
  /** The chosen candidates, best-first, at most `target` of them. */
  matches: T[];
  /**
   * How many higher-ranked candidates were skipped purely because of the
   * 30-day lock (i.e. repeats the rule prevented). usedInBatch and self/empty
   * skips are deliberately NOT counted here.
   */
  recentlyMatchedExcluded: number;
}

/**
 * Walk Pinecone candidates best-first and pick the first `target` that are
 * "fresh": not the member themselves, not locked by the 30-day rule, and not
 * already used in this batch. Pure and order-preserving so it can be unit
 * tested without touching Pinecone or the database.
 */
export function selectFreshMatches<T extends FreshMatchCandidate>(
  candidates: readonly T[],
  opts: SelectFreshMatchesOptions
): SelectFreshMatchesResult<T> {
  const { memberId, recentlyMatched, usedInBatch, target } = opts;
  const matches: T[] = [];
  let recentlyMatchedExcluded = 0;

  for (const candidate of candidates) {
    if (matches.length >= target) break;
    if (candidate.id === memberId) continue;

    const email = String(candidate.metadata.email ?? "").trim().toLowerCase();
    if (!email) continue;
    if (usedInBatch.has(email)) continue;
    if (recentlyMatched.has(email)) {
      recentlyMatchedExcluded++;
      continue;
    }

    matches.push(candidate);
  }

  return { matches, recentlyMatchedExcluded };
}
