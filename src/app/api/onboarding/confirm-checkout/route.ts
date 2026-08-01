/**
 * POST /api/onboarding/confirm-checkout
 * Authenticated Memberstack session required.
 * Verifies Stripe payment server-side and links cus_… → Airtable by Memberstack ID.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { confirmCheckoutForMember } from "@/lib/forms/billing/confirm-checkout";
import { FormsError } from "@/lib/forms/errors";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** Optional Stripe Checkout Session id from return URL */
  sessionId: z.string().trim().max(200).optional(),
  checkoutSessionId: z.string().trim().max(200).optional(),
});

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "confirm-checkout");
    if (limited) return limited;

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );

    let body: z.infer<typeof bodySchema> = {};
    try {
      const json = await request.json();
      const parsed = bodySchema.safeParse(json || {});
      if (parsed.success) body = parsed.data;
    } catch {
      body = {};
    }

    const sessionId = body.sessionId || body.checkoutSessionId || null;

    const result = await confirmCheckoutForMember({
      memberstackId: member.id,
      memberEmail: member.email,
      memberstackRaw: member.raw,
      checkoutSessionId: sessionId,
    });

    return withCors(
      NextResponse.json({
        success: true,
        paymentConfirmed: result.paymentConfirmed,
        status: result.status,
        // Never echo full customer id to client logs unnecessarily — mask
        stripeCustomerLinked: Boolean(result.stripeCustomerId),
        reason: result.reason,
        shadowed: result.shadowed || false,
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
          message: err instanceof Error ? err.message : "Checkout confirm failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
