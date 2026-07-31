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
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

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
        NextResponse.json({
          success: true,
          exists: false,
          memberstackId: member.id,
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
    const status = profile.onboardingStatus || "ACCOUNT_CREATED";
    const paymentConfirmed =
      status === "PAYMENT_CONFIRMED" ||
      status === "COMPLETE" ||
      ["GOAL", "HELP_WANTED", "EXPERTISE", "CONNECTION"].includes(status) ||
      profile.payment.toLowerCase() === "paid";
    // After checkout, never send members back to Payment — advance to post-pay profile.
    const resumeStage = mapResumeStage(status, paymentConfirmed);
    return withCors(
      NextResponse.json({
        success: true,
        exists: true,
        memberstackId: member.id,
        airtableRecordId: profile.airtableRecordId,
        onboardingStatus: status,
        resumeStage,
        paymentConfirmed,
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
          message: err instanceof Error ? err.message : "Status failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}

function mapResumeStage(status: string, paymentConfirmed: boolean): string {
  const order = [
    "ACCOUNT_CREATED",
    "LOCATION",
    "BUSINESS",
    "PAYMENT_PENDING",
    "PAYMENT_CONFIRMED",
    "GOAL",
    "HELP_WANTED",
    "EXPERTISE",
    "CONNECTION",
    "COMPLETE",
  ];
  if (status === "ACCOUNT_CREATED") return "LOCATION";
  if (status === "COMPLETE") return "COMPLETE";
  // Paid (or checkout return) → continue profile at GOAL, not Payment / success interstitial
  if (
    paymentConfirmed &&
    (status === "PAYMENT_PENDING" || status === "PAYMENT_CONFIRMED" || status === "BUSINESS")
  ) {
    return "GOAL";
  }
  if (status === "PAYMENT_CONFIRMED") return "GOAL";
  if (order.includes(status)) return status;
  return "ACCOUNT";
}

void MEMBER_FIELDS;
