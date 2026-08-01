/**
 * Trusted payment status for post-Stripe return polling.
 * Reads Airtable only — never accepts client-supplied Paid/Active claims.
 */
import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  findMemberByMemberstackId,
  recordToProfileDtoResolved,
} from "@/lib/forms/airtable/members-sync";
import { FormsError } from "@/lib/forms/errors";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

function isPaid(profile: { payment: string; membership: string }): boolean {
  return (
    profile.payment.trim().toLowerCase() === "paid" &&
    profile.membership.trim().toLowerCase() === "active"
  );
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
        NextResponse.json({
          success: true,
          exists: false,
          paymentConfirmed: false,
          payment: "",
          membership: "",
          onboardingStatus: null,
          resumeStage: "ACCOUNT",
        }),
        request
      );
    }
    if (rows.length > 1) {
      throw new FormsError("AIRTABLE_DUPLICATE_MEMBER", "Duplicate Memberstack ID");
    }
    const profile = await recordToProfileDtoResolved(rows[0]);
    const paymentConfirmed = isPaid(profile);
    const status = profile.onboardingStatus || "ACCOUNT_CREATED";

    return withCors(
      NextResponse.json({
        success: true,
        exists: true,
        paymentConfirmed,
        payment: profile.payment,
        membership: profile.membership,
        onboardingStatus: status,
        serviceAccessUntil: profile.serviceAccessUntil,
        stripeCustomerId: profile.stripeCustomerId ? "set" : "",
        airtableRecordId: profile.airtableRecordId,
        // Safe resume hint for UI only (billing truth is paymentConfirmed)
        resumeStage: paymentConfirmed
          ? status === "COMPLETE"
            ? "COMPLETE"
            : ["GOAL", "HELP_WANTED", "EXPERTISE", "CONNECTION"].includes(status)
              ? status
              : "GOAL"
          : status === "PAYMENT_PENDING" || status === "BUSINESS"
            ? "PAYMENT_PENDING"
            : status,
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
          message: err instanceof Error ? err.message : "Payment status failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
