import { NextResponse } from "next/server";
import type Stripe from "stripe";
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
import { customerHasPaymentMethod } from "@/lib/forms/billing/reactivate-membership";
import {
  classifyMembershipUiState,
  hasRemainingServiceAccess,
  parseTruthyFlag,
  resolveAccessUntilLabel,
} from "@/lib/forms/billing/membership-state";
import { getStripeClient } from "@/lib/integrations/stripe";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function periodEndFromSub(sub: Stripe.Subscription): string | null {
  const itemEnd = sub.items?.data?.[0]?.current_period_end;
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const unix =
    typeof itemEnd === "number" ? itemEnd : typeof top === "number" ? top : null;
  if (unix == null) return null;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function subscriptionToSnapshot(sub: Stripe.Subscription) {
  return {
    subscriptionStatus: sub.status,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    currentPeriodEnd: periodEndFromSub(sub),
    subscriptionId: sub.id,
  };
}

/**
 * Live Stripe is source of truth for cancel_at_period_end.
 * Prefer active/trialing cancel-scheduled subs, then any live sub, then stored id.
 */
async function loadLiveStripeSnapshot(
  stripeCustomerId: string,
  fallbackSubscriptionId?: string | null
): Promise<{
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean | null;
  currentPeriodEnd: string | null;
  subscriptionId: string | null;
}> {
  const empty = {
    subscriptionStatus: null as string | null,
    cancelAtPeriodEnd: null as boolean | null,
    currentPeriodEnd: null as string | null,
    subscriptionId: null as string | null,
  };

  if (!stripeCustomerId.startsWith("cus_")) return empty;

  try {
    const stripe = getStripeClient();

    // 1) Direct retrieve by stored sub id first (most precise after portal cancel)
    const stored = (fallbackSubscriptionId || "").trim();
    if (stored.startsWith("sub_")) {
      try {
        const direct = await stripe.subscriptions.retrieve(stored);
        if (direct && !("deleted" in direct && direct.deleted)) {
          return subscriptionToSnapshot(direct);
        }
      } catch {
        /* fall through to list */
      }
    }

    // 2) List all recent subs for this customer
    const subs = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 20,
    });

    const prefer =
      subs.data.find(
        (s) =>
          (s.status === "active" || s.status === "trialing") && s.cancel_at_period_end
      ) ||
      subs.data.find((s) => s.status === "active" || s.status === "trialing") ||
      subs.data.find((s) =>
        ["past_due", "unpaid", "incomplete"].includes(s.status)
      ) ||
      // Prefer most recently canceled over ancient ones
      [...subs.data]
        .filter((s) => s.status === "canceled")
        .sort((a, b) => (b.canceled_at || 0) - (a.canceled_at || 0))[0] ||
      subs.data[0];

    if (prefer) return subscriptionToSnapshot(prefer);
    return empty;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "billing_status_stripe_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return empty;
  }
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
          {
            success: false,
            code: "AIRTABLE_MEMBER_NOT_FOUND",
            message: "Member not found",
          },
          { status: 404 }
        ),
        request
      );
    }
    const row = rows[0];
    const profile = recordToProfileDto(row);
    const stripeCustomerId = profile.stripeCustomerId || "";

    const storedSubId =
      fieldStr(row.fields, MEMBER_FIELDS.stripeSubscriptionId) || null;

    // Run Stripe lookups independently so a PM failure never hides cancel state
    const [hasPaymentMethod, live] = await Promise.all([
      stripeCustomerId.startsWith("cus_")
        ? customerHasPaymentMethod(stripeCustomerId).catch(() => false)
        : Promise.resolve(false),
      loadLiveStripeSnapshot(stripeCustomerId, storedSubId),
    ]);

    // Stripe wins when known; otherwise robust Airtable flag parse
    const airtableCancel = parseTruthyFlag(profile.cancelAtPeriodEnd);
    const cancelAtPeriodEnd =
      live.cancelAtPeriodEnd != null ? live.cancelAtPeriodEnd : airtableCancel;

    const stripeSubscriptionStatus =
      live.subscriptionStatus ||
      fieldStr(row.fields, MEMBER_FIELDS.stripeSubscriptionStatus) ||
      null;

    const accessUntilLabel = resolveAccessUntilLabel({
      serviceAccessUntil: profile.serviceAccessUntil,
      currentPeriodEnd: live.currentPeriodEnd,
      cancellationEffectiveAt: profile.cancellationEffectiveAt,
    });

    const uiState = classifyMembershipUiState({
      membership: profile.membership,
      payment: profile.payment,
      serviceAccessUntil: profile.serviceAccessUntil || accessUntilLabel,
      cancelAtPeriodEnd,
      stripeSubscriptionStatus,
      hasPaymentMethod,
      currentPeriodEnd: live.currentPeriodEnd,
      cancellationEffectiveAt: profile.cancellationEffectiveAt,
    });

    const hasAccess = hasRemainingServiceAccess(
      profile.serviceAccessUntil || accessUntilLabel || live.currentPeriodEnd
    );

    const res = NextResponse.json({
      success: true,
      billing: {
        membership: profile.membership,
        payment: profile.payment,
        serviceAccessUntil:
          profile.serviceAccessUntil || accessUntilLabel || live.currentPeriodEnd || "",
        cancelAtPeriodEnd,
        cancellationEffectiveAt: profile.cancellationEffectiveAt,
        stripeCustomerId: stripeCustomerId || null,
        hasPaymentMethod,
        stripeSubscriptionStatus,
        stripeSubscriptionId: live.subscriptionId || storedSubId,
        currentPeriodEnd: live.currentPeriodEnd,
        uiState,
        hasServiceAccess: hasAccess,
        accessUntilLabel,
      },
      profile,
    });
    // Never cache membership state — cancel_at_period_end must be live
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return withCors(res, request);
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
    console.error(
      JSON.stringify({
        event: "billing_status_error",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: "Billing status failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
