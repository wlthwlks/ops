import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import {
  introductionsModePayload,
  IntroductionsConfigError,
} from "@/lib/introduction/runtime-mode";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  let modePayload;
  try {
    modePayload = introductionsModePayload();
  } catch (e) {
    if (e instanceof IntroductionsConfigError) {
      return NextResponse.json(
        { success: false, code: e.code, message: e.message },
        { status: 500 }
      );
    }
    throw e;
  }

  const allowedChannelIdsRaw = process.env.RECURRING_INTROS_ALLOWED_CHANNEL_IDS;
  const allowedChannelIds = allowedChannelIdsRaw
    ? allowedChannelIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const planTtlMinutes = parseInt(process.env.RECURRING_INTROS_PLAN_TTL_MINUTES || "30", 10);
  const memberCooldownDays = parseInt(process.env.INTRO_MEMBER_COOLDOWN_DAYS || "14", 10);
  const pairCooldownDays = parseInt(process.env.INTRO_PAIR_COOLDOWN_DAYS || "60", 10);
  const onboardingCooldownDays = parseInt(process.env.INTRO_ONBOARDING_TO_RECURRING_DAYS || "14", 10);

  let ledgerAvailable = false;
  try {
    await db.execute(sql`SELECT 1 FROM introduction_runs LIMIT 1`);
    ledgerAvailable = true;
  } catch {
    // Table doesn't exist yet — migration not applied
  }

  return NextResponse.json({
    ...modePayload,
    ledgerAvailable,
    allowedChannelCount: allowedChannelIds.length,
    memberCooldownDays,
    pairCooldownDays,
    onboardingCooldownDays,
    planTtlMinutes,
  });
}
