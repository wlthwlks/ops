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
import { resolveIndustryForWrite } from "@/lib/forms/reference-data";

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
    const patch = stepDataToAirtablePatch(stage, (data || {}) as Record<string, unknown>);
    const result = await updateOnboardingStep({
      memberstackId: member.id,
      stage,
      patch,
    });

    return withCors(
      NextResponse.json({
        success: true,
        stage,
        shadowed: result.shadowed,
        profile: result.record ? await recordToProfileDtoResolved(result.record) : null,
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

/** Map widget step data → canonical MEMBERS writable fields only. */
function stepDataToAirtablePatch(
  stage: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  switch (stage) {
    case "ACCOUNT":
      return {
        [MEMBER_FIELDS.firstName]: data.firstName,
        [MEMBER_FIELDS.lastName]: data.lastName,
        [MEMBER_FIELDS.email]: data.email,
        ...(data.phone != null ? { [MEMBER_FIELDS.phone]: data.phone } : {}),
        ...(data.phonePrefix != null
          ? { [MEMBER_FIELDS.phonePrefix]: data.phonePrefix }
          : {}),
      };
    case "LOCATION":
      return {
        // App-only keys → City text + City relation + Timezone
        _appCityCode: data.cityCode,
        _appCountryCode: data.countryCode,
        [MEMBER_FIELDS.availabilityV2]: data.availability,
      };
    case "BUSINESS": {
      const industry = resolveIndustryForWrite(
        data.primaryIndustry as string | undefined,
        data.otherIndustry as string | undefined
      );
      return {
        ...(industry != null ? { [MEMBER_FIELDS.industry]: industry } : {}),
        [MEMBER_FIELDS.businessStage]: data.businessStage,
        [MEMBER_FIELDS.revenue]: data.annualRevenue,
        [MEMBER_FIELDS.businessDescription]: data.businessDescription,
      };
    }
    case "PAYMENT_PENDING":
      return {};
    case "PAYMENT_CONFIRMED":
      // Navigation checkpoint only — never accept client-supplied Paid/Active/Stripe IDs.
      return {};
    case "GOAL":
      return {
        [MEMBER_FIELDS.ninetyDayGoal]: data.ninetyDayGoal,
        [MEMBER_FIELDS.goalUpdatedAt]: new Date().toISOString(),
      };
    case "HELP_WANTED":
      return {
        [MEMBER_FIELDS.helpWanted]: Array.isArray(data.helpWanted)
          ? data.helpWanted
          : [],
        [MEMBER_FIELDS.helpWantedContext]:
          typeof data.helpWantedContext === "string" ? data.helpWantedContext : "",
      };
    case "EXPERTISE":
      return {
        [MEMBER_FIELDS.expertise]: Array.isArray(data.expertiseOffered)
          ? data.expertiseOffered
          : Array.isArray(data.expertise)
            ? data.expertise
            : [],
        [MEMBER_FIELDS.expertiseContext]:
          typeof data.expertiseContext === "string" ? data.expertiseContext : "",
      };
    case "CONNECTION":
      return {
        [MEMBER_FIELDS.connectionType]: data.connectionType,
      };
    default:
      return {};
  }
}
