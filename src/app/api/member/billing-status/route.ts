import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  findMemberByMemberstackId,
  recordToProfileDto,
} from "@/lib/forms/airtable/members-sync";
import { FormsError } from "@/lib/forms/errors";

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
          { success: false, code: "AIRTABLE_MEMBER_NOT_FOUND", message: "Member not found" },
          { status: 404 }
        ),
        request
      );
    }
    const profile = recordToProfileDto(rows[0]);
    return withCors(
      NextResponse.json({
        success: true,
        billing: {
          membership: profile.membership,
          payment: profile.payment,
          serviceAccessUntil: profile.serviceAccessUntil,
          cancelAtPeriodEnd: profile.cancelAtPeriodEnd === "true",
          cancellationEffectiveAt: profile.cancellationEffectiveAt,
          stripeCustomerId: profile.stripeCustomerId || null,
        },
        profile,
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
          message: err instanceof Error ? err.message : "Billing status failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
