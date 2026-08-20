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
import { extractStripeCustomerIdFromMemberstackRaw } from "@/lib/forms/billing/confirm-checkout";
import { getStripeClient } from "@/lib/integrations/stripe";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { resolveIntroPauseState } from "@/lib/introduction/pause-state";

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
  const cancelAt = typeof sub.cancel_at === "number" ? sub.cancel_at : null;
  const unix =
    typeof itemEnd === "number"
      ? itemEnd
      : typeof top === "number"
        ? top
        : cancelAt;
  if (unix == null) return null;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/**
 * Memberstack / Stripe portal can schedule end via either:
 * - cancel_at_period_end: true
 * - cancel_at: unix timestamp (future)
 * Treat both as "cancellation scheduled" while the sub is still active/trialing.
 */
function isScheduledToCancel(sub: Stripe.Subscription): boolean {
  if (sub.cancel_at_period_end) return true;
  if (typeof sub.cancel_at === "number" && sub.cancel_at * 1000 > Date.now()) {
    return true;
  }
  return false;
}

function subscriptionToSnapshot(sub: Stripe.Subscription) {
  const pauseCollection = (sub.pause_collection ||
    null) as { behavior?: string; resumes_at?: number | null } | null;
  const resumesAt =
    pauseCollection && typeof pauseCollection.resumes_at === "number"
      ? pauseCollection.resumes_at
      : null;
  return {
    subscriptionStatus: sub.status,
    cancelAtPeriodEnd: isScheduledToCancel(sub),
    currentPeriodEnd: periodEndFromSub(sub),
    subscriptionId: sub.id,
    billingPause: {
      paused: sub.status === "paused",
      indefinite: sub.status === "paused" && !resumesAt,
      resumesAt: resumesAt
        ? new Date(resumesAt * 1000).toISOString().slice(0, 10)
        : null,
      behavior: pauseCollection?.behavior || null,
    },
  };
}

/**
 * Resolve Stripe customer id without trusting the browser.
 * Order: Airtable → Memberstack admin raw → unique Stripe email match.
 */
async function resolveStripeCustomerId(input: {
  airtableCustomerId: string;
  memberstackRaw?: Record<string, unknown> | null;
  email?: string;
}): Promise<{ customerId: string; source: string }> {
  const fromAt = (input.airtableCustomerId || "").trim();
  if (fromAt.startsWith("cus_")) {
    return { customerId: fromAt, source: "airtable" };
  }

  if (input.memberstackRaw) {
    const fromMs = extractStripeCustomerIdFromMemberstackRaw(input.memberstackRaw);
    if (fromMs.startsWith("cus_")) {
      return { customerId: fromMs, source: "memberstack" };
    }
  }

  const email = (input.email || "").trim().toLowerCase();
  if (email && email.includes("@")) {
    try {
      const stripe = getStripeClient();
      const found = await stripe.customers.list({ email, limit: 5 });
      const live = found.data.filter((c) => !c.deleted);
      if (live.length === 1 && live[0].id.startsWith("cus_")) {
        return { customerId: live[0].id, source: "stripe_email_unique" };
      }
    } catch {
      /* ignore */
    }
  }

  return { customerId: "", source: "none" };
}

/**
 * Live Stripe is source of truth for cancel_at_period_end.
 */
async function loadLiveStripeSnapshot(
  stripeCustomerId: string,
  fallbackSubscriptionId?: string | null
): Promise<{
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean | null;
  currentPeriodEnd: string | null;
  subscriptionId: string | null;
  billingPause: {
    paused: boolean;
    indefinite: boolean;
    resumesAt: string | null;
    behavior: string | null;
  } | null;
  error?: string | null;
}> {
  const empty = {
    subscriptionStatus: null as string | null,
    cancelAtPeriodEnd: null as boolean | null,
    currentPeriodEnd: null as string | null,
    subscriptionId: null as string | null,
    billingPause: null,
    error: null as string | null,
  };

  if (!stripeCustomerId.startsWith("cus_")) {
    return { ...empty, error: "no_customer_id" };
  }

  try {
    const stripe = getStripeClient();

    // 1) Direct retrieve by stored sub id (most precise after portal cancel)
    const stored = (fallbackSubscriptionId || "").trim();
    if (stored.startsWith("sub_")) {
      try {
        const direct = await stripe.subscriptions.retrieve(stored);
        if (direct && !("deleted" in direct && (direct as { deleted?: boolean }).deleted)) {
          // Trust the stored subscription only while it is still live. A stale
          // canceled/incomplete_expired id must not shadow a newer active
          // subscription (e.g. after the member re-subscribed and paid).
          if (direct.status !== "canceled" && direct.status !== "incomplete_expired") {
            return { ...subscriptionToSnapshot(direct), error: null };
          }
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
          (s.status === "active" || s.status === "trialing") && isScheduledToCancel(s)
      ) ||
      subs.data.find((s) => s.status === "active" || s.status === "trialing") ||
      subs.data.find(
        (s) =>
          ["past_due", "unpaid", "incomplete", "paused"].includes(s.status)
      ) ||
      [...subs.data]
        .filter((s) => s.status === "canceled")
        .sort((a, b) => (b.canceled_at || 0) - (a.canceled_at || 0))[0] ||
      subs.data[0];

    if (prefer) return { ...subscriptionToSnapshot(prefer), error: null };
    return { ...empty, error: "no_subscriptions" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "billing_status_stripe_lookup_failed",
        error: msg,
      })
    );
    return { ...empty, error: msg.slice(0, 200) };
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
    const airtableCustomerId = profile.stripeCustomerId || "";
    const memberEmail =
      profile.email ||
      (typeof member.email === "string" ? member.email : "") ||
      "";

    const resolved = await resolveStripeCustomerId({
      airtableCustomerId,
      memberstackRaw: (member.raw || null) as Record<string, unknown> | null,
      email: memberEmail,
    });
    const stripeCustomerId = resolved.customerId;

    const storedSubId =
      fieldStr(row.fields, MEMBER_FIELDS.stripeSubscriptionId) || null;

    const [hasPaymentMethod, live] = await Promise.all([
      stripeCustomerId.startsWith("cus_")
        ? customerHasPaymentMethod(stripeCustomerId).catch(() => false)
        : Promise.resolve(false),
      loadLiveStripeSnapshot(stripeCustomerId, storedSubId),
    ]);

    // Stripe wins when known; otherwise robust Airtable flag parse
    const airtableCancel = parseTruthyFlag(
      row.fields[MEMBER_FIELDS.cancelAtPeriodEnd] ?? profile.cancelAtPeriodEnd
    );
    // Also treat a future cancellation effective / cancellation date as scheduled cancel
    // when membership is still Active (common if cancel flag field is missing/mis-typed).
    const cancelEffective =
      fieldStr(row.fields, MEMBER_FIELDS.cancellationEffectiveAt) ||
      profile.cancellationEffectiveAt ||
      "";
    const cancelDateLegacy =
      fieldStr(row.fields, MEMBER_FIELDS.cancellationDate) ||
      profile.cancellationDate ||
      "";
    const futureCancelHint = (() => {
      const raw = cancelEffective || cancelDateLegacy;
      if (!raw) return false;
      const d = new Date(raw.length <= 10 ? `${raw}T23:59:59.999Z` : raw);
      if (Number.isNaN(d.getTime())) return false;
      return d.getTime() >= Date.now();
    })();
    const memLower = (profile.membership || "").toLowerCase();
    const airtableScheduledCancel =
      airtableCancel ||
      (futureCancelHint && (memLower === "active" || memLower === "cancelled" || memLower === "canceled"));

    const cancelAtPeriodEnd =
      live.cancelAtPeriodEnd != null ? live.cancelAtPeriodEnd : airtableScheduledCancel;

    const stripeSubscriptionStatus =
      live.subscriptionStatus ||
      fieldStr(row.fields, MEMBER_FIELDS.stripeSubscriptionStatus) ||
      null;

    const accessUntilLabel = resolveAccessUntilLabel({
      serviceAccessUntil: profile.serviceAccessUntil,
      currentPeriodEnd: live.currentPeriodEnd,
      cancellationEffectiveAt: cancelEffective || cancelDateLegacy,
    });

    const uiState = classifyMembershipUiState({
      membership: profile.membership,
      payment: profile.payment,
      serviceAccessUntil: profile.serviceAccessUntil || accessUntilLabel,
      cancelAtPeriodEnd,
      stripeSubscriptionStatus,
      hasPaymentMethod,
      currentPeriodEnd: live.currentPeriodEnd,
      cancellationEffectiveAt: cancelEffective || cancelDateLegacy,
      billingPauseResumesAt: live.billingPause?.resumesAt ?? null,
    });

    const hasAccess = hasRemainingServiceAccess(
      profile.serviceAccessUntil || accessUntilLabel || live.currentPeriodEnd
    );

    const introPause = resolveIntroPauseState(
      fieldStr(row.fields, MEMBER_FIELDS.recurringIntroStatus),
      fieldStr(row.fields, MEMBER_FIELDS.recurringPauseUntil) || null
    );

    console.error(
      JSON.stringify({
        event: "billing_status_snapshot",
        memberstackId: member.id,
        customerSource: resolved.source,
        hasCustomer: Boolean(stripeCustomerId),
        cancelAtPeriodEnd,
        uiState,
        stripeSubscriptionStatus,
        liveError: live.error || null,
        accessUntilLabel: accessUntilLabel || null,
      })
    );

    const res = NextResponse.json({
      success: true,
      billing: {
        membership: profile.membership,
        payment: profile.payment,
        serviceAccessUntil:
          profile.serviceAccessUntil ||
          accessUntilLabel ||
          live.currentPeriodEnd ||
          "",
        cancelAtPeriodEnd,
        cancellationEffectiveAt: cancelEffective || cancelDateLegacy || profile.cancellationEffectiveAt,
        stripeCustomerId: stripeCustomerId || null,
        hasPaymentMethod,
        stripeSubscriptionStatus,
        stripeSubscriptionId: live.subscriptionId || storedSubId,
        currentPeriodEnd: live.currentPeriodEnd,
        uiState,
        hasServiceAccess: hasAccess,
        accessUntilLabel,
        billingPause: live.billingPause ?? {
          paused: false,
          indefinite: false,
          resumesAt: null,
          behavior: null,
        },
        introPause: {
          state: introPause.state,
          isPaused: introPause.isPaused,
          pauseUntil: introPause.pauseUntilDate
            ? introPause.pauseUntilDate.toISOString().slice(0, 10)
            : null,
          missingDate: introPause.missingDate,
        },
        /** Helps debug without secrets — safe for client */
        customerResolvedFrom: resolved.source,
        stripeLookupError: live.error || null,
      },
      profile,
    });
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
