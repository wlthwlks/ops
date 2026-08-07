import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import { onboardingStepSchema } from "@/lib/forms/schemas/onboarding";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  updateOnboardingStep,
  recordToProfileDtoResolved,
} from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { FormsError } from "@/lib/forms/errors";
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

export async function PATCH(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "onboarding-step");
    if (limited) return limited;

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );
    const body = await request.json();
    const parsed = onboardingStepSchema.safeParse(body);
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

    const { stage, data } = parsed.data;
    const raw = (data || {}) as Record<string, unknown>;
    const { patch, msFields } = await stepDataToAirtablePatch(stage, raw);
    const result = await updateOnboardingStep({
      memberstackId: member.id,
      stage,
      patch,
    });

    let memberstackCustomFieldsSynced = true;
    let memberstackSyncWarning: string | undefined;
    if (Object.keys(msFields).length > 0) {
      const msSync = await syncMemberstackCustomFields({
        memberId: member.id,
        fields: msFields,
      });
      memberstackCustomFieldsSynced = msSync.ok;
      if (!msSync.ok) memberstackSyncWarning = msSync.message;
    }

    return withCors(
      NextResponse.json({
        success: true,
        stage,
        shadowed: result.shadowed,
        profile: result.record ? await recordToProfileDtoResolved(result.record) : null,
        memberstackCustomFieldsSynced,
        ...(memberstackSyncWarning
          ? {
              memberstackSyncWarning,
              code: "MEMBERSTACK_CUSTOM_FIELDS_PARTIAL",
            }
          : {}),
      }),
      request
    );
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: err.code,
            message: err.message,
            details: err.details,
          },
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
          message: err instanceof Error ? err.message : "Step save failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}

type MsFields = {
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  city?: string;
  country?: string;
  postCode?: string;
};

/** Map widget step data → canonical MEMBERS writable fields + MS custom fields. */
async function stepDataToAirtablePatch(
  stage: string,
  data: Record<string, unknown>
): Promise<{ patch: Record<string, unknown>; msFields: MsFields }> {
  switch (stage) {
    case "ACCOUNT": {
      const firstName = data.firstName != null ? String(data.firstName) : undefined;
      const lastName = data.lastName != null ? String(data.lastName) : undefined;
      return {
        patch: {
          [MEMBER_FIELDS.firstName]: data.firstName,
          [MEMBER_FIELDS.lastName]: data.lastName,
          [MEMBER_FIELDS.email]: data.email,
        },
        msFields: {
          ...(firstName != null ? { firstName } : {}),
          ...(lastName != null ? { lastName } : {}),
        },
      };
    }
    case "LOCATION": {
      const phonePrefix = String(data.phonePrefix || "").trim();
      const phoneRaw = String(data.phone || "").trim();
      const iso2 = String(data.countryIso2 || "").trim() || null;
      const phoneResult = validatePhoneParts(phonePrefix, phoneRaw, iso2);
      if (!phoneResult.ok) {
        throw new FormsError("PROFILE_VALIDATION_FAILED", phoneResult.message, {
          status: 400,
          retryable: false,
        });
      }
      const postCode = normalizePostCode(
        data.postCode != null ? String(data.postCode) : ""
      );

      let cityLabel = "";
      let countryLabel = "";
      const cityCode = String(data.cityCode || "").trim();
      if (cityCode) {
        const city = await findCatalogCityByCode(cityCode);
        if (city) {
          cityLabel = city.label;
          countryLabel = city.countryLabel;
        }
      }

      return {
        patch: {
          _appCityCode: data.cityCode,
          _appCountryCode: data.countryCode,
          [MEMBER_FIELDS.availabilityV2]: data.availability,
          [MEMBER_FIELDS.phone]: phoneResult.national,
          [MEMBER_FIELDS.phonePrefix]: phoneResult.prefix,
          [MEMBER_FIELDS.postCode]: postCode,
        },
        msFields: {
          phoneNumber: phoneResult.e164,
          ...(cityLabel ? { city: cityLabel } : {}),
          ...(countryLabel ? { country: countryLabel } : {}),
          postCode,
        },
      };
    }
    case "BUSINESS": {
      const industry = resolveIndustryForWrite(
        data.primaryIndustry as string | undefined,
        data.otherIndustry as string | undefined
      );
      return {
        patch: {
          ...(industry != null ? { [MEMBER_FIELDS.industry]: industry } : {}),
          [MEMBER_FIELDS.businessStage]: data.businessStage,
          [MEMBER_FIELDS.revenue]: data.annualRevenue,
          [MEMBER_FIELDS.businessDescription]: data.businessDescription,
        },
        msFields: {},
      };
    }
    case "PAYMENT_PENDING":
    case "PAYMENT_CONFIRMED":
      // Navigation checkpoint only — never accept client-supplied Paid/Active/Stripe IDs.
      return { patch: {}, msFields: {} };
    case "GOAL":
      return {
        patch: {
          [MEMBER_FIELDS.ninetyDayGoal]: data.ninetyDayGoal,
          [MEMBER_FIELDS.goalUpdatedAt]: new Date().toISOString(),
        },
        msFields: {},
      };
    case "HELP_WANTED":
      return {
        patch: {
          [MEMBER_FIELDS.helpWanted]: Array.isArray(data.helpWanted)
            ? data.helpWanted
            : [],
          [MEMBER_FIELDS.helpWantedContext]:
            typeof data.helpWantedContext === "string" ? data.helpWantedContext : "",
        },
        msFields: {},
      };
    case "EXPERTISE":
      return {
        patch: {
          [MEMBER_FIELDS.expertise]: Array.isArray(data.expertiseOffered)
            ? data.expertiseOffered
            : Array.isArray(data.expertise)
              ? data.expertise
              : [],
          [MEMBER_FIELDS.expertiseContext]:
            typeof data.expertiseContext === "string" ? data.expertiseContext : "",
        },
        msFields: {},
      };
    case "CONNECTION":
      return {
        patch: {
          [MEMBER_FIELDS.connectionType]: data.connectionType,
        },
        msFields: {},
      };
    default:
      return { patch: {}, msFields: {} };
  }
}
