/**
 * POST /api/member/reactivate
 * Reactivate membership for the authenticated member (server resolves Stripe ids).
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
      : result.status === "no_payment_method" || result.status === "payment_problem"
        ? 402
        : 400;

    return withCors(
      NextResponse.json(
        {
          success: result.success,
          status: result.status,
          reason: result.reason,
          /** Clients that only read `message` (widgetApi) get the human copy. */
          message: result.message || result.reason,
          subscriptionId: result.subscriptionId || null,
          subscriptionStatus: result.subscriptionStatus || null,
          paymentMethodReused: result.paymentMethodReused || false,
          charged: Boolean(result.charged),
          nextRenewalDate: result.nextRenewalDate || null,
          currentPeriodEnd: result.currentPeriodEnd || null,
          requiresPaymentMethod: Boolean(result.requiresPaymentMethod),
        },
        { status: httpStatus }
      ),
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
            reason: err.message,
          },
          { status: err.status }
        ),
        request
      );
    }
    console.error(
      JSON.stringify({
        event: "member_reactivate_error",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: "We could not reactivate your membership. Please try again.",
          reason: "We could not reactivate your membership. Please try again.",
        },
        { status: 500 }
      ),
      request
    );
  }
}
