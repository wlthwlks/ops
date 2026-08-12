import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import { bootstrapSchema } from "@/lib/forms/schemas/onboarding";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { upsertMinimalSignupMember, recordToProfileDto } from "@/lib/forms/airtable/members-sync";
import { FormsError } from "@/lib/forms/errors";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";
import { syncMemberstackCustomFields } from "@/lib/forms/memberstack/custom-fields";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "onboarding-bootstrap");
    if (limited) return limited;

    const flags = getFormFeatureFlags();
    if (!flags.newSignupWidgetEnabled && process.env.NODE_ENV === "production") {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "FLAG_DISABLED",
            message: "NEW_SIGNUP_WIDGET_ENABLED is false",
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
    const parsed = bootstrapSchema.safeParse({
      ...body,
      email: body.email || member.email,
      firstName: body.firstName || member.firstName,
      lastName: body.lastName || member.lastName,
      age: body.age,
    });
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

    const result = await upsertMinimalSignupMember(
      {
        memberstackId: member.id,
        email: parsed.data.email,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        age: parsed.data.age,
        attribution: parsed.data.attribution as Record<string, string | undefined>,
        source: "signup_widget",
      },
      undefined,
      { caller: "bootstrap" }
    );

    // bootstrap is the canonical creator. In normal operation the result is
    // never deferred and `record` is non-null — but defensively, if a race
    // caused a transient deferral (e.g. webhook owner crashed mid-create),
    // surface a retryable 503 so the user re-submits and we never fabricate
    // a fake Airtable id.
    if (result.deferred || !result.record) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "SIGNUP_CREATION_IN_PROGRESS",
            message:
              "Signup is being processed by another request — please retry",
            retryable: true,
          },
          { status: 503 }
        ),
        request
      );
    }

    // Best-effort MS custom fields (never account email). Airtable already saved.
    const msSync = await syncMemberstackCustomFields({
      memberId: member.id,
      fields: {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
      },
    });

    return withCors(
      NextResponse.json({
        success: true,
        created: result.created,
        shadowed: result.shadowed,
        airtableRecordId: result.record.id,
        onboardingStatus:
          (result.record.fields[MEMBER_FIELDS.onboardingStatus] as string) ||
          "ACCOUNT_CREATED",
        profile: result.record.id !== "shadow" ? recordToProfileDto(result.record) : null,
        memberstackId: member.id,
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
          {
            success: false,
            code: err.code,
            message: err.message,
            details: err.details,
            retryable: err.retryable,
          },
          { status: err.status }
        ),
        request
      );
    }
    const msg = err instanceof Error ? err.message : "Bootstrap failed";
    return withCors(
      NextResponse.json(
        { success: false, code: "INTERNAL_UNEXPECTED_ERROR", message: msg },
        { status: 500 }
      ),
      request
    );
  }
}
