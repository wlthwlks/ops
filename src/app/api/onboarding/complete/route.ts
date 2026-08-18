import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { updateOnboardingStep, recordToProfileDto } from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { FormsError } from "@/lib/forms/errors";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";
import { db } from "@/db";
import { formAnalyticsEvents } from "@/db/schema";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "onboarding-complete");
    if (limited) return limited;

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );
    const result = await updateOnboardingStep({
      memberstackId: member.id,
      stage: "COMPLETE",
      patch: {
        [MEMBER_FIELDS.onboardingStatus]: "COMPLETE",
        [MEMBER_FIELDS.profileSchemaVersion]: "2",
        [MEMBER_FIELDS.onboardingCompletedAt]: new Date().toISOString(),
      },
    });
    if (getFormFeatureFlags().newFormAnalyticsEnabled) {
      try {
        await db.insert(formAnalyticsEvents).values({
          id: randomUUID(),
          eventType: "ONBOARDING_COMPLETED",
          memberstackId: member.id,
        });
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "form_analytics_insert_failed",
            eventType: "ONBOARDING_COMPLETED",
            memberstackId: member.id,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }
    return withCors(
      NextResponse.json({
        success: true,
        shadowed: result.shadowed,
        homeUrl: process.env.WLTH_HOME_URL || "https://wlthwlks.com",
        profile: result.record ? recordToProfileDto(result.record) : null,
      }),
      request
    );
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        ),
        request
      );
    }
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : "Complete failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
