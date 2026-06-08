import { sql } from "drizzle-orm";
import type { AppDb } from "@/db";

export interface EmailSuccessRate {
  sent: number;
  failed: number;
  pct: number | null;
}

export interface MatchmakeKpis {
  matchesSentToday: number;
  membersReachedToday: number;
  emailSuccessRate: EmailSuccessRate;
  lastSendAt: Date | null;
  generatedAt: Date;
}

type CountRow = {
  count: string | number | null;
  [key: string]: unknown;
};

type LastSendRow = {
  last_send_at: Date | string | null;
  [key: string]: unknown;
};

type EmailStatusRow = {
  sent: string | number | null;
  failed: string | number | null;
  [key: string]: unknown;
};

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function computePct(sent: number, failed: number): number | null {
  const total = sent + failed;
  if (total === 0) {
    return null;
  }
  return Math.round((sent / total) * 10_000) / 100;
}

/**
 * Reads from the production `db` exported by `@/db` by default. Tests pass an
 * alternate AppDb so the same query logic runs against an embedded PGlite.
 * The production `db` is imported lazily so that test environments without
 * `POSTGRES_URL` set can supply their own database instance without
 * triggering the module-load-time validation in `@/db`.
 */
export async function getMatchmakeKpis(
  database?: AppDb
): Promise<MatchmakeKpis> {
  const resolved = database ?? (await import("@/db")).db;
  return runKpiQueries(resolved);
}

async function runKpiQueries(database: AppDb): Promise<MatchmakeKpis> {
  // 1. Matches sent today — non-dry-run, not soft-deleted, since UTC midnight.
  const matchesResult = await database.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS count
    FROM match_events
    WHERE created_at >= date_trunc('day', now())
      AND dry_run = false
      AND deleted_at IS NULL
  `);

  // 2. Distinct members reached today — union new-member + matched-member emails.
  const membersResult = await database.execute<CountRow>(sql`
    SELECT COUNT(DISTINCT email)::int AS count FROM (
      SELECT new_member_email AS email
      FROM match_events
      WHERE created_at >= date_trunc('day', now())
        AND dry_run = false
        AND deleted_at IS NULL
      UNION
      SELECT m.match_email AS email
      FROM match_event_matches m
      JOIN match_events e ON e.id = m.match_event_id
      WHERE e.created_at >= date_trunc('day', now())
        AND e.dry_run = false
        AND e.deleted_at IS NULL
    ) u
  `);

  // 3. Email success rate since UTC midnight.
  const emailResult = await database.execute<EmailStatusRow>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent', 'delivered'))::int AS sent,
      COUNT(*) FILTER (WHERE status IN ('failed', 'bounced', 'complained'))::int AS failed
    FROM email_deliveries
    WHERE sent_at >= date_trunc('day', now())
  `);

  // 4. Last send timestamp across non-deleted, non-dry-run events.
  const lastSendResult = await database.execute<LastSendRow>(sql`
    SELECT MAX(created_at) AS last_send_at
    FROM match_events
    WHERE deleted_at IS NULL
      AND dry_run = false
  `);

  const matchesRow = extractRow<CountRow>(matchesResult);
  const membersRow = extractRow<CountRow>(membersResult);
  const emailRow = extractRow<EmailStatusRow>(emailResult);
  const lastSendRow = extractRow<LastSendRow>(lastSendResult);

  const sent = toNumber(emailRow?.sent ?? 0);
  const failed = toNumber(emailRow?.failed ?? 0);

  return {
    matchesSentToday: toNumber(matchesRow?.count ?? 0),
    membersReachedToday: toNumber(membersRow?.count ?? 0),
    emailSuccessRate: {
      sent,
      failed,
      pct: computePct(sent, failed),
    },
    lastSendAt: toDate(lastSendRow?.last_send_at ?? null),
    generatedAt: new Date(),
  };
}

/**
 * Different drivers return query results in slightly different shapes:
 * - neon-http returns `{ rows: T[] }` (when configured) or a plain `T[]`
 * - pglite returns `{ rows: T[] }`
 * Normalise to the first row regardless of shape.
 */
function extractRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) {
    return result[0] as T | undefined;
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows[0] as T | undefined;
    }
  }
  return undefined;
}
