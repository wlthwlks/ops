/**
 * SweatPals lifecycle feed sync (poll-based event source).
 *
 * SweatPals exposes paginated, most-recent-first feeds for membership
 * lifecycle events (zapier-provider): new-members, cancelled-members and
 * renewed-members. This module pages through each feed, tracks a per-feed
 * cursor (newest row timestamp already processed) and runs the standard
 * reconcile pipeline for fresh rows — SweatPals external API lookup → local
 * snapshot upsert → Airtable billing mirror. Duplicate reprocessing is safe
 * because reconcile upserts are idempotent.
 */
import { db } from "@/db";
import { sweatpalsFeedCursors } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  getZapierFeed,
  SweatpalsApiError,
  type SweatpalsFeedName,
  type SweatpalsFeedRow,
} from "@/lib/integrations/sweatpals";
import { reconcileSweatpalsMember } from "@/lib/forms/sweatpals/verify-membership";

export type SweatpalsFeedSyncOptions = {
  /** Single feed to sync, or "all" (default). */
  feed?: SweatpalsFeedName | "all";
  /** Max pages per feed (pageSize 100 each). */
  maxPages?: number;
  pageSize?: number;
  /** false (default) = compute only, never mirror Airtable. */
  apply?: boolean;
};

export type SweatpalsFeedSyncResult = {
  feed: string;
  scanned: number;
  processed: number;
  skippedNoIdentity: number;
  synced: number;
  failed: number;
  /** Cursor persisted (apply runs only). */
  cursorAdvancedTo: string | null;
  /** Cursor the run would persist on an apply run. */
  nextCursor: string | null;
  error?: string;
  lastReconcileError?: string;
};

const ALL_FEEDS: SweatpalsFeedName[] = ["new-members", "cancelled-members", "renewed-members"];

function rowTimestamp(row: SweatpalsFeedRow): string | null {
  return row.createdAt || row.updatedAt || row.renewedAt || null;
}

async function readCursor(feed: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ cursor: sweatpalsFeedCursors.cursor })
      .from(sweatpalsFeedCursors)
      .where(eq(sweatpalsFeedCursors.feed, feed))
      .limit(1);
    return rows[0]?.cursor ?? null;
  } catch {
    return null;
  }
}

async function writeCursor(feed: string, cursor: string | null): Promise<void> {
  try {
    await db
      .insert(sweatpalsFeedCursors)
      .values({ feed, cursor, lastRunAt: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: sweatpalsFeedCursors.feed,
        set: {
          cursor: cursor ?? undefined,
          lastRunAt: new Date(),
          updatedAt: new Date(),
        },
      });
  } catch {
    /* cursor persistence is best-effort */
  }
}

/** Sync a single feed once. Cursor only advances when the run reaches a clean page boundary. */
export async function syncSweatpalsFeed(
  feed: SweatpalsFeedName,
  opts: SweatpalsFeedSyncOptions = {}
): Promise<SweatpalsFeedSyncResult> {
  const result: SweatpalsFeedSyncResult = {
    feed,
    scanned: 0,
    processed: 0,
    skippedNoIdentity: 0,
    synced: 0,
    failed: 0,
    cursorAdvancedTo: null,
    nextCursor: null,
    lastReconcileError: undefined,
  };
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 5;
  const cursor = await readCursor(feed);

  let maxSeen: string | null = null;
  let done = false;

  try {
    for (let page = 1; page <= maxPages && !done; page++) {
      const rows = await getZapierFeed(feed, { page, pageSize });
      if (rows.length === 0) {
        done = true;
        break;
      }
      let freshInPage = 0;
      for (const row of rows) {
        result.scanned += 1;
        const ts = rowTimestamp(row);
        if (ts && maxSeen === null) maxSeen = ts;
        if (ts && maxSeen !== null && ts > maxSeen) maxSeen = ts;

        if (cursor && ts && ts <= cursor) continue;
        freshInPage += 1;

        const email = (row.user_email || "").trim();
        const phone = (row.user_phone || "").trim();
        if (!email && !phone) {
          result.skippedNoIdentity += 1;
          continue;
        }
        result.processed += 1;
        try {
          const res = await reconcileSweatpalsMember({
            emails: [email || undefined],
            phone: phone || undefined,
            mirrorEmail: email || undefined,
            dryRun: !opts.apply,
          });
          if (res.status === "api_error" || res.status === "not_configured") {
            result.failed += 1;
            if (!result.lastReconcileError) {
              result.lastReconcileError = res.reason || res.status;
            }
          } else {
            result.synced += 1;
          }
        } catch (e) {
          result.failed += 1;
          if (!result.lastReconcileError) {
            result.lastReconcileError = e instanceof Error ? e.message : String(e);
          }
        }
      }
      // Most-recent-first: once a full page carries no fresh rows, later pages won't either.
      if (freshInPage === 0) {
        done = true;
      } else if (rows.length < pageSize) {
        done = true;
      }
    }

    if (maxSeen && (!cursor || maxSeen > cursor)) {
      result.nextCursor = maxSeen;
      // Cursors persist on apply runs only — a dry-run must not consume rows.
      if (opts.apply) {
        await writeCursor(feed, maxSeen);
        result.cursorAdvancedTo = maxSeen;
      }
    }
  } catch (e) {
    result.error =
      e instanceof SweatpalsApiError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
  }

  return result;
}

export async function syncSweatpalsFeeds(
  opts: SweatpalsFeedSyncOptions = {}
): Promise<SweatpalsFeedSyncResult[]> {
  const feeds = opts.feed && opts.feed !== "all" ? [opts.feed] : ALL_FEEDS;
  const results: SweatpalsFeedSyncResult[] = [];
  for (const feed of feeds) {
    results.push(await syncSweatpalsFeed(feed, opts));
  }
  return results;
}
