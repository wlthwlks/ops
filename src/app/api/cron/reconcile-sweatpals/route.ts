import { NextRequest, NextResponse, connection } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import { listSweatpalsReconcileKeys } from "@/lib/forms/sweatpals/reconcile";
import { reconcileSweatpalsMember } from "@/lib/forms/sweatpals/verify-membership";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Daily SweatPals gating reconcile: re-fetch membership state for members
 * with SweatPals linkage (oldest sync first, bounded) and mirror the derived
 * state to Airtable (active/paused/expired + service access window).
 */
export async function POST(request: NextRequest) {
  await connection();
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  if (
    process.env.SWEATPALS_RECONCILE_CRON_ENABLED !== "true" &&
    process.env.SWEATPALS_RECONCILE_CRON_ENABLED !== "1"
  ) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "SWEATPALS_RECONCILE_CRON_ENABLED is not true",
    });
  }

  const limit = parseInt(process.env.SWEATPALS_RECONCILE_CRON_MAX || "100", 10) || 100;

  try {
    const keys = await listSweatpalsReconcileKeys({ limit });
    const tally: Record<string, number> = {};
    let changed = 0;
    for (const key of keys) {
      const res = await reconcileSweatpalsMember({
        memberstackId: key.memberId || undefined,
        emails: [key.email || undefined],
        phone: key.phone || undefined,
        mirrorEmail: key.email || undefined,
        dryRun: false,
      });
      tally[res.status] = (tally[res.status] || 0) + 1;
      tally[`mirror:${res.mirrorStatus}`] = (tally[`mirror:${res.mirrorStatus}`] || 0) + 1;
      changed += res.changedCount;
    }
    return NextResponse.json({
      success: true,
      processed: keys.length,
      changed,
      tally,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "SweatPals reconcile failed",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  await connection();
  return POST(request);
}
