/**
 * POST /api/member/reactivate
 * Reactivate membership with saved Stripe card (no portal).
 */
import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { reactivateMembershipForMember } from "@/lib/forms/billing/reactivate-membership";
import { FormsError } from "@/lib/forms/errors";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "member-reactivate");
    if (limited) return limited;

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );

    const result = await reactivateMembershipForMember({
      memberstackId: member.id,
    });

    const httpStatus = result.success
      ? 200
      : result.status === "no_payment_method"
        ? 402
        : 400;
    return withCors(
      NextResponse.json(
        {
          success: result.success,
          status: result.status,
          reason: result.reason,
          subscriptionId: result.subscriptionId || null,
          subscriptionStatus: result.subscriptionStatus || null,
          paymentMethodReused: result.paymentMethodReused || false,
        },
        { status: httpStatus }
      ),
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
          message: err instanceof Error ? err.message : "Reactivate failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
