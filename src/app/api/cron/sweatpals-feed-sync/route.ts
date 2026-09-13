import { NextRequest, NextResponse, connection } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import { syncSweatpalsFeeds } from "@/lib/forms/sweatpals/feeds";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Hourly SweatPals lifecycle feed sync: polls the zapier-provider feeds
 * (new-members / cancelled-members / renewed-members) and reconciles fresh
 * rows into the local snapshot + Airtable billing mirror.
 */
export async function POST(request: NextRequest) {
  await connection();
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  if (
    process.env.SWEATPALS_FEED_SYNC_CRON_ENABLED !== "true" &&
    process.env.SWEATPALS_FEED_SYNC_CRON_ENABLED !== "1"
  ) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "SWEATPALS_FEED_SYNC_CRON_ENABLED is not true",
    });
  }

  try {
    const results = await syncSweatpalsFeeds({ apply: true });
    return NextResponse.json({
      success: true,
      feeds: results,
      totals: {
        processed: results.reduce((n, r) => n + r.processed, 0),
        synced: results.reduce((n, r) => n + r.synced, 0),
        failed: results.reduce((n, r) => n + r.failed, 0),
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "SweatPals feed sync failed",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  await connection();
  return POST(request);
}
