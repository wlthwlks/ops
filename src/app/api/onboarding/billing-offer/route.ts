/**
 * POST /api/onboarding/billing-offer
 * Authenticated Memberstack session required.
 * Resolves a customer-facing promo code server-side against the billing
 * catalog. Never accepts client-supplied Stripe/Memberstack price ids —
 * only the offer code. Invalid/disabled codes return a clear error and must
 * NOT fall back to the default price.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { resolveOffer } from "@/lib/billing/catalog";
import { findMemberByMemberstackId } from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { FormsError } from "@/lib/forms/errors";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** Customer-facing promo code. Client-supplied price ids are never accepted. */
  code: z.string().trim().max(64).optional(),
});

const OFFER_ERROR_MESSAGES: Record<
  "unknown" | "disabled" | "expired" | "not_started" | "new_customers_only" | "unavailable",
  string
> = {
  unknown: "This promo code is invalid or has expired.",
  disabled: "This promo code is no longer available.",
  expired: "This promo code has expired.",
  not_started: "This promo code is not active yet.",
  new_customers_only: "This promo code is only available for new members.",
  unavailable: "This promo code is currently unavailable.",
};

async function isNewCustomer(memberstackId: string): Promise<boolean> {
  try {
    const rows = await findMemberByMemberstackId(memberstackId);
    if (rows.length !== 1) return true;
    const f = rows[0].fields;
    const payment = String(f[MEMBER_FIELDS.payment] || "").toLowerCase();
    const membership = String(f[MEMBER_FIELDS.membership] || "").toLowerCase();
    return !(payment === "paid" && membership === "active");
  } catch {
    return true;
  }
}

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "billing-offer");
    if (limited) return limited;

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );

    let code = "";
    try {
      const json = await request.json();
      const parsed = bodySchema.safeParse(json || {});
      if (parsed.success) code = parsed.data.code || "";
    } catch {
      code = "";
    }

    if (!code) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            applied: false,
            code: "MISSING_OFFER_CODE",
            message: "Enter a promo code.",
          },
          { status: 400 }
        ),
        request
      );
    }

    const newCustomer = await isNewCustomer(member.id);
    const resolution = resolveOffer(code, { newCustomer });

    if (!resolution.ok) {
      const message =
        OFFER_ERROR_MESSAGES[resolution.status] ||
        OFFER_ERROR_MESSAGES.unknown;
      return withCors(
        NextResponse.json(
          {
            success: false,
            applied: false,
            code: "INVALID_OFFER_CODE",
            status: resolution.status,
            message,
          },
          { status: 400 }
        ),
        request
      );
    }

    const price = resolution.price;
    if (!price.memberstackPriceId) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            applied: false,
            code: "INVALID_OFFER_CODE",
            status: "unavailable",
            message: "This promo code is currently unavailable.",
          },
          { status: 400 }
        ),
        request
      );
    }

    return withCors(
      NextResponse.json({
        success: true,
        applied: true,
        offerCode: resolution.offerCode,
        priceKey: price.priceKey,
        memberstackPriceId: price.memberstackPriceId,
        label: price.label || null,
        description: price.description || null,
        trialDays: price.trialDays ?? null,
      }),
      request
    );
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          { success: false, applied: false, code: err.code, message: err.message },
          { status: err.status }
        ),
        request
      );
    }
    return withCors(
      NextResponse.json(
        {
          success: false,
          applied: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : "Offer resolution failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
