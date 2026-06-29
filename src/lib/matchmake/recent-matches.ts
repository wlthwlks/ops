import { sql } from "drizzle-orm";
import type { AppDb } from "@/db";

/**
 * Default rolling window (in days) over which a community member is considered
 * "recently matched" and therefore locked out of being suggested again.
 */
export const MATCH_LOCK_DAYS = 30;

type EmailRow = {
  email: string | null;
  [key: string]: unknown;
};

/**
 * Returns the set of lowercased emails of every member who participated in a
 * real (non-dry-run, non-deleted) match event within the rolling window —
 * counting BOTH the new joiner being introduced and the suggested matches
 * ("any participation"). Used by the matching engine to avoid matching the
 * same existing member more than once per window.
 *
 * Reads from the production `db` exported by `@/db` by default. Tests pass an
 * alternate AppDb so the same query runs against an embedded PGlite.
 */
export async function getRecentlyMatchedEmails(
  database?: AppDb,
  windowDays: number = MATCH_LOCK_DAYS
): Promise<Set<string>> {
  const resolved = database ?? (await import("@/db")).db;
  // Interval is composed from a sanitised integer — windowDays is never
  // user-supplied, but coerce defensively so it can only ever be a number.
  const days = Math.max(0, Math.floor(windowDays));

  const result = await resolved.execute<EmailRow>(sql`
    SELECT lower(new_member_email) AS email
    FROM match_events
    WHERE created_at >= now() - (${days} * INTERVAL '1 day')
      AND dry_run = false
      AND deleted_at IS NULL
    UNION
    SELECT lower(m.match_email) AS email
    FROM match_event_matches m
    JOIN match_events e ON e.id = m.match_event_id
    WHERE e.created_at >= now() - (${days} * INTERVAL '1 day')
      AND e.dry_run = false
      AND e.deleted_at IS NULL
  `);

  const rows = extractRows<EmailRow>(result);
  const emails = new Set<string>();
  for (const row of rows) {
    if (row.email) emails.add(row.email);
  }
  return emails;
}

/**
 * Normalise driver result shapes: neon-http returns a plain array (or
 * `{ rows }`), pglite returns `{ rows }`. Mirrors the helper in kpis.ts.
 */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows as T[];
    }
  }
  return [];
}
