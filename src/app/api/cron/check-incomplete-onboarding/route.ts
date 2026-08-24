import { NextRequest, NextResponse, connection } from "next/server";
import { scanIncompleteOnboarding } from "@/lib/forms/onboarding/incomplete-scan";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  await connection();
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  if (
    process.env.NEW_SIGNUP_WIDGET_ENABLED !== "true" &&
    process.env.NEW_SIGNUP_WIDGET_ENABLED !== "1"
  ) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "Signup widget writes disabled",
    });
  }

  try {
    const result = await scanIncompleteOnboarding({
      staleHours: parseInt(process.env.INCOMPLETE_ONBOARDING_STALE_HOURS || "48", 10) || 48,
      maxRecords: parseInt(process.env.INCOMPLETE_ONBOARDING_MAX || "100", 10) || 100,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Incomplete onboarding scan failed",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  await connection();
  return POST(request);
}
