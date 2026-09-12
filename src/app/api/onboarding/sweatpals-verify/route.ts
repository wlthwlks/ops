/**
 * POST /api/onboarding/sweatpals-verify
 * Authenticated Memberstack session required.
 *
 * Verifies the member's SweatPals membership server-side via the external
 * API (lookup-only), upserts `sweatpals_memberships` rows and mirrors the
 * derived state to the Airtable billing columns (Membership / Payment /
 * Service access until). Never creates users on SweatPals.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { verifySweatpalsMembershipForMember } from "@/lib/forms/sweatpals/verify-membership";
import { FormsError } from "@/lib/forms/errors";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** Email as typed inside the SweatPals checkout (authoritative lookup). */
  email: z.string().trim().max(200).optional(),
  /** Phone as typed inside the SweatPals checkout. */
  phone: z.string().trim().max(60).optional(),
});

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "sweatpals-verify");
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

    const result = await verifySweatpalsMembershipForMember({
      memberstackId: member.id,
      memberEmail: member.email,
      lookupEmail: body.email || undefined,
      lookupPhone: body.phone || undefined,
    });

    return withCors(
      NextResponse.json({
        success: result.success,
        membershipConfirmed: result.membershipConfirmed,
        active: result.active,
        paused: result.paused,
        count: result.count,
        status: result.status,
        reason: result.reason,
        shadowed: result.shadowed,
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
          message:
            err instanceof Error ? err.message : "SweatPals verification failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
