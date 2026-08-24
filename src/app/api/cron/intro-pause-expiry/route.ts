import { NextResponse, connection } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import {
  autoResumeExpiredPauses,
  getOpsAirtableClient,
} from "@/lib/ops/member-pause";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Nightly intro-pause expiry.
 *
 * Members whose "Recurring intro status" is still "Paused" but whose
 * "Recurring pause until" date has passed are switched back to "Active"
 * (and the date cleared) so introductions resume automatically.
 *
 * Fail-closed: "Paused" with a missing/unparsable date is never auto-resumed —
 * the ops directory flags those via PAUSED_WITH_MISSING_DATE.
 *
 * Env gates:
 *   PAUSE_EXPIRY_CRON_ENABLED=true   enables the route (fail-closed otherwise)
 */
export async function GET(request: Request) {
  await connection();
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  if (
    process.env.PAUSE_EXPIRY_CRON_ENABLED !== "true" &&
    process.env.PAUSE_EXPIRY_CRON_ENABLED !== "1"
  ) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "PAUSE_EXPIRY_CRON_ENABLED is not true",
    });
  }

  try {
    const airtable = getOpsAirtableClient();
    const { resumed } = await autoResumeExpiredPauses(airtable);
    console.error(
      JSON.stringify({ event: "intro_pause_expiry_cron", resumed: resumed.length })
    );
    return NextResponse.json({
      success: true,
      resumed: resumed.length,
      members: resumed.map((r) => ({
        airtableRecordId: r.airtableRecordId,
        email: r.email,
        name: r.name,
        pauseUntil: r.pauseUntil,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "intro_pause_expiry_cron_failed", error: msg }));
    return NextResponse.json(
      { success: false, error: "Intro pause expiry cron failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  await connection();
  return GET(request);
}
