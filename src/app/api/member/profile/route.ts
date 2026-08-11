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
import {
  normalizeBusinessWebsite,
  normalizeBusinessName,
  normalizeProfessionalHeadline,
  normalizeProfileBio,
  normalizeSocialUrl,
  findDuplicateSocialPlatforms,
  serializeSocialMediaField,
  type SocialLink,
  isSocialPlatform,
} from "@/lib/forms/validation/profile-urls";

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

    // ------- Validate -------

    const body = await request.json();
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const fields: Record<string, string> = {};
      for (const [k, msgs] of Object.entries(flat.fieldErrors || {})) {
        const m = Array.isArray(msgs) ? msgs[0] : msgs;
        if (m) fields[k] = String(m);
      }
      const firstMsg =
        Object.values(fields)[0] ||
        flat.formErrors?.[0] ||
        "Please check the highlighted fields.";
      return withCors(
        NextResponse.json(
          {
            success: false,
            error: "VALIDATION_ERROR",
            code: "PROFILE_VALIDATION_FAILED",
            message: firstMsg,
            fields,
            details: flat,
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

    // ------- Personal -------

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
        const phoneResult = validatePhoneParts(prefix, phone, d.countryIso2 || null);
        if (!phoneResult.ok) {
          throw new FormsError("PROFILE_VALIDATION_FAILED", phoneResult.message, {
            status: 400,
            retryable: false,
            details: { fieldErrors: { phone: [phoneResult.message] }, formErrors: [] },
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

    // ------- Location -------

    if (d.cityCode != null) patch._appCityCode = d.cityCode;
    if (d.countryCode != null) patch._appCountryCode = d.countryCode;
    if (d.availability != null) patch[MEMBER_FIELDS.availabilityV2] = d.availability;

    if (d.cityCode) {
      const city = await findCatalogCityByCode(d.cityCode);
      if (city) {
        msFields.city = city.label;
        msFields.country = city.countryLabel;
      } else if (String(d.cityCode).trim()) {
        throw new FormsError("PROFILE_VALIDATION_FAILED", "Please select your city.", {
          status: 400,
          retryable: false,
          details: { fieldErrors: { cityCode: ["Please select your city."] }, formErrors: [] },
        });
      }
    }

    // ------- Business -------

    if (d.primaryIndustry != null) {
      const industry = resolveIndustryForWrite(d.primaryIndustry, d.otherIndustry);
      if (industry != null) patch[MEMBER_FIELDS.industry] = industry;
    }
    if (d.businessStage != null) patch[MEMBER_FIELDS.businessStage] = d.businessStage;
    if (d.annualRevenue != null) patch[MEMBER_FIELDS.revenue] = d.annualRevenue;
    if (d.businessDescription != null)
      patch[MEMBER_FIELDS.businessDescription] = d.businessDescription;

    if (d.businessName !== undefined)
      patch[MEMBER_FIELDS.businessName] = normalizeBusinessName(d.businessName);
    if (d.businessWebsite !== undefined) {
      const websiteResult = normalizeBusinessWebsite(d.businessWebsite);
      if (!websiteResult.ok) {
        throw new FormsError("PROFILE_VALIDATION_FAILED", websiteResult.message, {
          status: 400,
          retryable: false,
          details: { fieldErrors: { businessWebsite: [websiteResult.message] }, formErrors: [] },
        });
      }
      patch[MEMBER_FIELDS.businessWebsite] = websiteResult.url;
    }
    if (d.professionalHeadline !== undefined)
      patch[MEMBER_FIELDS.professionalHeadline] = normalizeProfessionalHeadline(d.professionalHeadline);
    if (d.profileBio !== undefined)
      patch[MEMBER_FIELDS.profileBio] = normalizeProfileBio(d.profileBio);

    // ------- Social links -------

    if (d.socialLinks !== undefined) {
      if (Array.isArray(d.socialLinks)) {
        const dupe = findDuplicateSocialPlatforms(d.socialLinks);
        if (dupe) {
          throw new FormsError("PROFILE_VALIDATION_FAILED", `Duplicate social platform: ${dupe}`, {
            status: 400,
            retryable: false,
            details: { fieldErrors: { socialLinks: [`Duplicate social platform: ${dupe}`] }, formErrors: [] },
          });
        }
        const validLinks: SocialLink[] = [];
        for (const link of d.socialLinks) {
          if (!link.platform || !link.url || !isSocialPlatform(link.platform)) continue;
          const result = normalizeSocialUrl(link.platform, link.url);
          if (!result.ok) {
            throw new FormsError("PROFILE_VALIDATION_FAILED", result.message, {
              status: 400,
              retryable: false,
              details: { fieldErrors: { socialLinks: [result.message] }, formErrors: [] },
            });
          }
          if (result.url) {
            validLinks.push({ platform: link.platform, url: result.url });
          }
        }
        patch[MEMBER_FIELDS.socialMedia] = serializeSocialMediaField(validLinks);
      } else {
        patch[MEMBER_FIELDS.socialMedia] = "";
      }
    }

    // ------- Matching -------

    if (d.ninetyDayGoal != null) {
      patch[MEMBER_FIELDS.ninetyDayGoal] = d.ninetyDayGoal;
      patch[MEMBER_FIELDS.goalUpdatedAt] = new Date().toISOString();
    }
    if (d.helpWanted !== undefined) patch[MEMBER_FIELDS.helpWanted] = d.helpWanted;
    if (d.helpWantedContext !== undefined)
      patch[MEMBER_FIELDS.helpWantedContext] = d.helpWantedContext;
    if (d.expertiseOffered !== undefined)
      patch[MEMBER_FIELDS.expertise] = d.expertiseOffered;
    if (d.expertiseContext !== undefined)
      patch[MEMBER_FIELDS.expertiseContext] = d.expertiseContext;

    if (d.connectionType != null) patch[MEMBER_FIELDS.connectionType] = d.connectionType;
    if (d.topicsToDiscuss != null) patch[MEMBER_FIELDS.topicsToDiscuss] = d.topicsToDiscuss;

    // ------- Write -------

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
      const details = err.details as { fieldErrors?: Record<string, string[]> } | undefined;
      const fields: Record<string, string> = {};
      if (details?.fieldErrors) {
        for (const [k, msgs] of Object.entries(details.fieldErrors)) {
          const m = Array.isArray(msgs) ? msgs[0] : msgs;
          if (m) fields[k] = String(m);
        }
      }
      return withCors(
        NextResponse.json(
          {
            success: false,
            error: Object.keys(fields).length ? "VALIDATION_ERROR" : undefined,
            code: err.code,
            message: err.message,
            details: err.details,
            ...(Object.keys(fields).length ? { fields } : {}),
          },
          { status: err.status }
        ),
        request
      );
    }
    console.error(
      JSON.stringify({
        event: "profile_patch_error",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: "Profile update failed. Please try again.",
        },
        { status: 500 }
      ),
      request
    );
  }
}
