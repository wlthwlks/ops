/**
 * GET /api/member/sweatpals-status
 * Authenticated Memberstack session required.
 *
 * Read-only SweatPals membership status for the signed-in member. Looks the
 * member up on SweatPals (email from the Memberstack session), refreshes the
 * local `sweatpals_memberships` snapshot, and returns the derived status.
 * Airtable mirroring is dry-run (the reconcile cron owns billing writes).
 */
import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { reconcileSweatpalsMember } from "@/lib/forms/sweatpals/verify-membership";
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

    const result = await reconcileSweatpalsMember({
      memberstackId: member.id,
      emails: [member.email],
      dryRun: true,
    });

    return withCors(
      NextResponse.json({
        success: true,
        configured: result.status !== "not_configured",
        status: result.status,
        active: result.active,
        paused: result.paused,
        count: result.count,
        membershipName: result.membershipName,
        accessUntil: result.accessUntil,
        reason: result.reason,
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
            err instanceof Error ? err.message : "SweatPals status failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
