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
import {
  findCatalogCityByCode,
  resolveIndustryForWrite,
  validatePhoneParts,
} from "@/lib/forms/reference-data";
import { normalizePostCode } from "@/lib/forms/reference-data/country-phone";
import { syncMemberstackCustomFields } from "@/lib/forms/memberstack/custom-fields";

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
    const msFields: {
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      city?: string;
      country?: string;
      postCode?: string;
    } = {};

    if (d.firstName != null) {
      patch[MEMBER_FIELDS.firstName] = d.firstName;
      msFields.firstName = d.firstName;
    }
    if (d.lastName != null) {
      patch[MEMBER_FIELDS.lastName] = d.lastName;
      msFields.lastName = d.lastName;
    }

    if (d.phone != null || d.phonePrefix != null) {
      const prefix = (d.phonePrefix || "").trim();
      const phone = (d.phone || "").trim();
      if (prefix || phone) {
        const phoneResult = validatePhoneParts(
          prefix,
          phone,
          d.countryIso2 || null
        );
        if (!phoneResult.ok) {
          throw new FormsError("PROFILE_VALIDATION_FAILED", phoneResult.message, {
            status: 400,
            retryable: false,
          });
        }
        patch[MEMBER_FIELDS.phone] = phoneResult.national;
        patch[MEMBER_FIELDS.phonePrefix] = phoneResult.prefix;
        msFields.phoneNumber = phoneResult.e164;
      }
    }

    if (d.postCode !== undefined) {
      const postCode = normalizePostCode(d.postCode || "");
      patch[MEMBER_FIELDS.postCode] = postCode;
      msFields.postCode = postCode;
    }

    if (d.cityCode != null) patch._appCityCode = d.cityCode;
    if (d.countryCode != null) patch._appCountryCode = d.countryCode;
    if (d.availability != null) patch[MEMBER_FIELDS.availabilityV2] = d.availability;

    if (d.cityCode) {
      const city = await findCatalogCityByCode(d.cityCode);
      if (city) {
        msFields.city = city.label;
        msFields.country = city.countryLabel;
      }
    }

    if (d.primaryIndustry != null) {
      const industry = resolveIndustryForWrite(d.primaryIndustry, d.otherIndustry);
      if (industry != null) patch[MEMBER_FIELDS.industry] = industry;
    }

    if (d.businessStage != null) patch[MEMBER_FIELDS.businessStage] = d.businessStage;
    if (d.annualRevenue != null) patch[MEMBER_FIELDS.revenue] = d.annualRevenue;
    if (d.businessDescription != null)
      patch[MEMBER_FIELDS.businessDescription] = d.businessDescription;
    if (d.ninetyDayGoal != null) {
      patch[MEMBER_FIELDS.ninetyDayGoal] = d.ninetyDayGoal;
      patch[MEMBER_FIELDS.goalUpdatedAt] = new Date().toISOString();
    }

    // Explicit arrays (including []) clear linked selections; omit = leave unchanged.
    if (d.helpWanted !== undefined) patch[MEMBER_FIELDS.helpWanted] = d.helpWanted;
    if (d.helpWantedContext !== undefined)
      patch[MEMBER_FIELDS.helpWantedContext] = d.helpWantedContext;
    if (d.expertiseOffered !== undefined)
      patch[MEMBER_FIELDS.expertise] = d.expertiseOffered;
    if (d.expertiseContext !== undefined)
      patch[MEMBER_FIELDS.expertiseContext] = d.expertiseContext;

    if (d.connectionType != null) patch[MEMBER_FIELDS.connectionType] = d.connectionType;
    if (d.topicsToDiscuss != null) patch[MEMBER_FIELDS.topicsToDiscuss] = d.topicsToDiscuss;

    const result = await updateMemberProfile({
      memberstackId: member.id,
      patch,
    });

    const msSync = await syncMemberstackCustomFields({
      memberId: member.id,
      fields: msFields,
    });

    return withCors(
      NextResponse.json({
        success: true,
        shadowed: result.shadowed,
        profile: await recordToProfileDtoResolved(result.record),
        memberstackCustomFieldsSynced: msSync.ok,
        ...(msSync.ok
          ? {}
          : {
              memberstackSyncWarning: msSync.message,
              code: "MEMBERSTACK_CUSTOM_FIELDS_PARTIAL",
            }),
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
