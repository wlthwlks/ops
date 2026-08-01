import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  findMemberByMemberstackId,
  recordToProfileDtoResolved,
  updateMemberProfile,
} from "@/lib/forms/airtable/members-sync";
import { updateProfileSchema } from "@/lib/forms/schemas/onboarding";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { FormsError } from "@/lib/forms/errors";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  try {
    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );
    const rows = await findMemberByMemberstackId(member.id);
    if (rows.length === 0) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "AIRTABLE_MEMBER_NOT_FOUND",
            message: "No Airtable member for this account",
          },
          { status: 404 }
        ),
        request
      );
    }
    return withCors(
      NextResponse.json({
        success: true,
        profile: await recordToProfileDtoResolved(rows[0]),
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
          message: err instanceof Error ? err.message : "Profile load failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "member-profile");
    if (limited) return limited;

    const flags = getFormFeatureFlags();
    if (!flags.newUpdateDetailsWidgetEnabled && process.env.NODE_ENV === "production") {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "FLAG_DISABLED",
            message: "NEW_UPDATE_DETAILS_WIDGET_ENABLED is false",
          },
          { status: 503 }
        ),
        request
      );
    }

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );
    const body = await request.json();
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "PROFILE_VALIDATION_FAILED",
            message: parsed.error.message,
            details: parsed.error.flatten(),
          },
          { status: 400 }
        ),
        request
      );
    }

    const d = parsed.data;
    const patch: Record<string, unknown> = {};
    if (d.firstName != null) patch[MEMBER_FIELDS.firstName] = d.firstName;
    if (d.lastName != null) patch[MEMBER_FIELDS.lastName] = d.lastName;
    if (d.phone != null) patch[MEMBER_FIELDS.phone] = d.phone;
    if (d.cityCode != null) patch._appCityCode = d.cityCode;
    if (d.countryCode != null) patch._appCountryCode = d.countryCode;
    if (d.availability != null) patch[MEMBER_FIELDS.availabilityV2] = d.availability;
    if (d.primaryIndustry != null) patch[MEMBER_FIELDS.industry] = d.primaryIndustry;
    if (d.businessStage != null) patch[MEMBER_FIELDS.businessStage] = d.businessStage;
    if (d.annualRevenue != null) patch[MEMBER_FIELDS.revenue] = d.annualRevenue;
    if (d.businessDescription != null)
      patch[MEMBER_FIELDS.businessDescription] = d.businessDescription;
    if (d.ninetyDayGoal != null) {
      patch[MEMBER_FIELDS.ninetyDayGoal] = d.ninetyDayGoal;
      patch[MEMBER_FIELDS.goalUpdatedAt] = new Date().toISOString();
    }
    if (d.helpWantedContext != null)
      patch[MEMBER_FIELDS.helpWantedContext] = d.helpWantedContext;
    else if (d.helpWanted != null)
      patch[MEMBER_FIELDS.helpWantedContext] = d.helpWanted.join(", ");
    if (d.expertiseContext != null)
      patch[MEMBER_FIELDS.expertiseContext] = d.expertiseContext;
    else if (d.expertiseOffered != null)
      patch[MEMBER_FIELDS.expertiseContext] = d.expertiseOffered.join(", ");
    if (d.connectionType != null) patch[MEMBER_FIELDS.connectionType] = d.connectionType;
    if (d.topicsToDiscuss != null) patch[MEMBER_FIELDS.topicsToDiscuss] = d.topicsToDiscuss;

    const result = await updateMemberProfile({
      memberstackId: member.id,
      patch,
    });

    return withCors(
      NextResponse.json({
        success: true,
        shadowed: result.shadowed,
        profile: await recordToProfileDtoResolved(result.record),
      }),
      request
    );
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          { success: false, code: err.code, message: err.message, details: err.details },
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
          message: err instanceof Error ? err.message : "Profile update failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
