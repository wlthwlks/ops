import { NextResponse } from "next/server";
import { z } from "zod";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  updateMemberstackEmail,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  findMemberByMemberstackId,
  findMemberByNormalizedEmailForSignupRecovery,
  updateMemberProfile,
  recordToProfileDto,
} from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { FormsError } from "@/lib/forms/errors";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";

export const runtime = "nodejs";

const schema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
});

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "member-email");
    if (limited) return limited;

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );
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

    const newEmail = parsed.data.email;
    if (newEmail === member.email) {
      return withCors(
        NextResponse.json({ success: true, unchanged: true, email: newEmail }),
        request
      );
    }

    // Check Airtable for conflicts (other memberstack id)
    const emailHits = await findMemberByNormalizedEmailForSignupRecovery(newEmail);
    const conflict = emailHits.find((r) => {
      const ms = String(r.fields[MEMBER_FIELDS.memberstackId] || "");
      return ms && ms !== member.id;
    });
    if (conflict) {
      throw new FormsError("MEMBERSTACK_EMAIL_CONFLICT", "Email already used by another member", {
        status: 409,
      });
    }

    // Memberstack first
    await updateMemberstackEmail({ memberId: member.id, newEmail });

    const rows = await findMemberByMemberstackId(member.id);
    const previousEmail =
      rows[0] ? String(rows[0].fields[MEMBER_FIELDS.email] || member.email) : member.email;

    try {
      const result = await updateMemberProfile({
        memberstackId: member.id,
        patch: {
          [MEMBER_FIELDS.email]: newEmail,
        },
      });
      await recordIntegrationError({
        code: "INTERNAL_UNEXPECTED_ERROR",
        source: "update_details",
        operation: "email_change_audit",
        title: "Email changed",
        message: `Previous ${previousEmail} → ${newEmail}`,
        severity: "info",
        memberstackId: member.id,
        airtableRecordId: result.record.id,
        details: { previousEmail, newEmail },
      }).catch(() => undefined);

      return withCors(
        NextResponse.json({
          success: true,
          email: newEmail,
          previousEmail,
          profile: recordToProfileDto(result.record),
        }),
        request
      );
    } catch (airtableErr) {
      await recordIntegrationError({
        code: "AIRTABLE_WRITE_FAILED",
        source: "update_details",
        operation: "email_change",
        title: "Memberstack email updated but Airtable failed",
        message: airtableErr instanceof Error ? airtableErr.message : "Airtable failed",
        severity: "critical",
        retryable: true,
        memberstackId: member.id,
        details: { previousEmail, newEmail },
      });
      throw airtableErr;
    }
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
          message: err instanceof Error ? err.message : "Email update failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
