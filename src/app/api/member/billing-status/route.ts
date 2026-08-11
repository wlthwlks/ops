import { NextResponse } from "next/server";
import Stripe from "stripe";
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
  formatMembershipAccessDate,
  hasRemainingServiceAccess,
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

async function loadLiveStripeSnapshot(
  stripeCustomerId: string,
  fallbackSubscriptionId?: string | null
): Promise<{
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean | null;
  currentPeriodEnd: string | null;
  subscriptionId: string | null;
}> {
  if (!stripeCustomerId.startsWith("cus_")) {
    return { subscriptionStatus: null, cancelAtPeriodEnd: null, currentPeriodEnd: null, subscriptionId: null };
  }
  try {
    const stripe = getStripeClient();
    const subs = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
    });
    const prefer =
      subs.data.find(
        (s) => (s.status === "active" || s.status === "trialing") && s.cancel_at_period_end
      ) ||
      subs.data.find((s) => s.status === "active" || s.status === "trialing") ||
      subs.data.find((s) => ["past_due", "unpaid", "incomplete"].includes(s.status)) ||
      subs.data[0];

    if (prefer) {
      return subscriptionToSnapshot(prefer);
    }

    // If list returned nothing useful, try direct lookup by stored sub id.
    const stored = (fallbackSubscriptionId || "").trim();
    if (stored.startsWith("sub_")) {
      try {
        const direct = await stripe.subscriptions.retrieve(stored);
        return subscriptionToSnapshot(direct);
      } catch {
        /* direct lookup also failed — return nulls */
      }
    }
    return { subscriptionStatus: null, cancelAtPeriodEnd: null, currentPeriodEnd: null, subscriptionId: null };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "billing_status_stripe_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return { subscriptionStatus: null, cancelAtPeriodEnd: null, currentPeriodEnd: null, subscriptionId: null };
  }
}

function subscriptionToSnapshot(sub: Stripe.Subscription) {
  const itemEnd = sub.items?.data?.[0]?.current_period_end;
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const unix = typeof itemEnd === "number" ? itemEnd : typeof top === "number" ? top : null;
  return {
    subscriptionStatus: sub.status,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    currentPeriodEnd: unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null,
    subscriptionId: sub.id,
  };
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
    const hasPaymentMethod = stripeCustomerId.startsWith("cus_")
      ? await customerHasPaymentMethod(stripeCustomerId)
      : false;

    const storedSubId = fieldStr(row.fields, MEMBER_FIELDS.stripeSubscriptionId) || null;
    const live = await loadLiveStripeSnapshot(stripeCustomerId, storedSubId);
    const airtableCancel = profile.cancelAtPeriodEnd === "true";
    const cancelAtPeriodEnd =
      live.cancelAtPeriodEnd != null ? live.cancelAtPeriodEnd : airtableCancel;
    const stripeSubscriptionStatus =
      live.subscriptionStatus ||
      fieldStr(row.fields, MEMBER_FIELDS.stripeSubscriptionStatus) ||
      null;

    const uiState = classifyMembershipUiState({
      membership: profile.membership,
      payment: profile.payment,
      serviceAccessUntil: profile.serviceAccessUntil,
      cancelAtPeriodEnd,
      stripeSubscriptionStatus,
      hasPaymentMethod,
      currentPeriodEnd: live.currentPeriodEnd,
    });

    const accessUntil = formatMembershipAccessDate(profile.serviceAccessUntil);
    const hasAccess = hasRemainingServiceAccess(profile.serviceAccessUntil);

    return withCors(
      NextResponse.json({
        success: true,
        billing: {
          membership: profile.membership,
          payment: profile.payment,
          serviceAccessUntil: profile.serviceAccessUntil,
          cancelAtPeriodEnd,
          cancellationEffectiveAt: profile.cancellationEffectiveAt,
          stripeCustomerId: stripeCustomerId || null,
          hasPaymentMethod,
          stripeSubscriptionStatus,
          stripeSubscriptionId: live.subscriptionId,
          currentPeriodEnd: live.currentPeriodEnd,
          uiState,
          hasServiceAccess: hasAccess,
          accessUntilLabel: accessUntil,
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
