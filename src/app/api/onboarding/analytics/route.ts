import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import { db } from "@/db";
import { formAnalyticsEvents } from "@/db/schema";
import { z } from "zod";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";

export const runtime = "nodejs";

const schema = z.object({
  eventType: z.enum([
    "FORM_VIEWED",
    "ACCOUNT_STARTED",
    "ACCOUNT_COMPLETED",
    "LOCATION_COMPLETED",
    "BUSINESS_COMPLETED",
    "CHECKOUT_STARTED",
    "CHECKOUT_ELIGIBLE",
    "PAYMENT_RETURNED",
    "PROFILE_ENRICHMENT_STARTED",
    "ONBOARDING_COMPLETED",
    "FORM_ABANDONED",
  ]),
  sessionId: z.string().max(120).optional(),
  memberstackId: z.string().max(120).optional(),
  airtableRecordId: z.string().max(120).optional(),
  stage: z.string().max(60).optional(),
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  const limited = enforcePublicWriteRateLimit(request, "onboarding-analytics");
  if (limited) return limited;

  const flags = getFormFeatureFlags();
  if (!flags.newFormAnalyticsEnabled) {
    return withCors(
      NextResponse.json({ success: true, recorded: false, reason: "analytics_disabled" }),
      request
    );
  }
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return withCors(
        NextResponse.json(
          { success: false, code: "PROFILE_VALIDATION_FAILED", message: parsed.error.message },
          { status: 400 }
        ),
        request
      );
    }
    const d = parsed.data;
    try {
      await db.insert(formAnalyticsEvents).values({
        id: randomUUID(),
        eventType: d.eventType,
        sessionId: d.sessionId || null,
        memberstackId: d.memberstackId || null,
        airtableRecordId: d.airtableRecordId || null,
        stage: d.stage || null,
        utmSource: d.utm_source || null,
        utmMedium: d.utm_medium || null,
        utmCampaign: d.utm_campaign || null,
        metadataJson: d.metadata ? JSON.stringify(d.metadata).slice(0, 4000) : null,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "form_analytics_insert_failed",
          eventType: d.eventType,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
    return withCors(NextResponse.json({ success: true, recorded: true }), request);
  } catch (err) {
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : "Analytics failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
