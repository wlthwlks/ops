/**
 * Stripe-derived membership entitlement calculator.
 * Reuses existing membership Price ID qualification logic.
 * Never creates Airtable members. Never email-matches.
 */
import type Stripe from "stripe";
import {
  getMembershipPeriodEnd,
  getQualifyingMembershipPriceIds,
  listAllInvoiceLines,
  listPaidInvoicesForCustomer,
  resolveNativeMembershipAllowlist,
} from "@/lib/billing/service-access-sync";
import { getStripeNativeMembershipPriceIds } from "@/lib/integrations/stripe";

export type RefundKind = "none" | "partial" | "full" | "unknown";

export type QualifyingPaymentPeriod = {
  invoiceId: string;
  chargeId: string | null;
  subscriptionId: string | null;
  priceIds: string[];
  periodEndUnix: number;
  periodEndIso: string;
  amountPaid: number;
  amountRefunded: number;
  refundKind: RefundKind;
  contributesToEntitlement: boolean;
};

export type StripeSubscriptionSnapshot = {
  id: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  cancelAtUnix: number | null;
  canceledAtUnix: number | null;
  endedAtUnix: number | null;
  currentPeriodEndUnix: number | null;
};

export type CancellationKind =
  | "none"
  | "cancel_at_period_end"
  | "scheduled_end"
  | "immediate"
  | "ambiguous";

export type StripeEntitlementResult = {
  stripeCustomerId: string;
  hasEntitlementNow: boolean;
  paidThroughUnix: number | null;
  paidThroughIso: string | null;
  referenceUnix: number;
  qualifyingPayments: QualifyingPaymentPeriod[];
  contributingInvoiceIds: string[];
  fullyRefundedInvoiceIds: string[];
  partiallyRefundedInvoiceIds: string[];
  subscriptionIds: string[];
  priceIds: string[];
  primarySubscription: StripeSubscriptionSnapshot | null;
  cancellationKind: CancellationKind;
  effectiveCancellationUnix: number | null;
  notes: string[];
  confidence: "high" | "medium" | "low";
};

export type StripeInvoiceListClient = {
  invoices: {
    list: (params: {
      customer: string;
      status: "paid";
      limit?: number;
      starting_after?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => Promise<{ data: any[]; has_more: boolean }>;
    listLineItems: (
      invoiceId: string,
      params?: { limit?: number; starting_after?: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => Promise<{ data: any[]; has_more: boolean }>;
  };
  subscriptions?: {
    list: (params: {
      customer: string;
      status?: "all" | "active" | "canceled" | "trialing" | "past_due";
      limit?: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => Promise<{ data: any[] }>;
  };
  charges?: {
    retrieve: (
      id: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => Promise<any>;
  };
};

function membershipAllowlist(membershipPriceIds?: Set<string>): Set<string> {
  if (membershipPriceIds && membershipPriceIds.size > 0) {
    return resolveNativeMembershipAllowlist(membershipPriceIds);
  }
  try {
    return getStripeNativeMembershipPriceIds({
      requireConfigured: false,
      failClosedInProduction: false,
    });
  } catch {
    return new Set();
  }
}

/**
 * Classify refund using Stripe charge amounts when available.
 * Full: amount_refunded >= amount_captured/amount_paid (and > 0), or refunded===true.
 * Partial: amount_refunded > 0 and less than paid.
 */
export function classifyChargeRefund(input: {
  amountPaid?: number | null;
  amountCaptured?: number | null;
  amountRefunded?: number | null;
  refunded?: boolean | null;
}): RefundKind {
  const paid = Math.max(
    0,
    Number(input.amountCaptured ?? input.amountPaid ?? 0) || 0
  );
  const refundedAmt = Math.max(0, Number(input.amountRefunded ?? 0) || 0);
  if (input.refunded === true && (refundedAmt >= paid || paid === 0)) {
    return "full";
  }
  if (refundedAmt <= 0) return "none";
  if (paid > 0 && refundedAmt >= paid) return "full";
  if (refundedAmt > 0 && paid > 0 && refundedAmt < paid) return "partial";
  if (input.refunded === true) return "full";
  return "unknown";
}

export function classifyChargeRefundFromStripe(charge: {
  amount?: number | null;
  amount_captured?: number | null;
  amount_refunded?: number | null;
  refunded?: boolean | null;
}): RefundKind {
  return classifyChargeRefund({
    amountPaid: charge.amount,
    amountCaptured: charge.amount_captured,
    amountRefunded: charge.amount_refunded,
    refunded: charge.refunded,
  });
}

function invoiceChargeId(inv: Stripe.Invoice): string | null {
  const legacy = inv as unknown as {
    charge?: string | { id?: string } | null;
    payment_intent?: string | { id?: string } | null;
  };
  if (typeof legacy.charge === "string" && legacy.charge.startsWith("ch_")) {
    return legacy.charge;
  }
  if (
    legacy.charge &&
    typeof legacy.charge === "object" &&
    typeof legacy.charge.id === "string"
  ) {
    return legacy.charge.id;
  }
  return null;
}

function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const raw = (inv as unknown as { subscription?: string | { id?: string } | null })
    .subscription;
  if (typeof raw === "string" && raw.startsWith("sub_")) return raw;
  if (raw && typeof raw === "object" && typeof raw.id === "string") return raw.id;
  return null;
}

function invoiceAmountPaid(inv: Stripe.Invoice): number {
  const n = (inv as unknown as { amount_paid?: number }).amount_paid;
  return typeof n === "number" ? n : 0;
}

/**
 * Distinguishes immediate cancellation from period-end natural end.
 * Conservative: ambiguous → do not clamp.
 */
export function classifySubscriptionCancellation(
  sub: {
    status?: string | null;
    cancel_at_period_end?: boolean | null;
    cancel_at?: number | null;
    canceled_at?: number | null;
    ended_at?: number | null;
    current_period_end?: number | null;
  },
  options?: { eventUnix?: number | null; paidThroughUnix?: number | null }
): {
  kind: CancellationKind;
  effectiveUnix: number | null;
  notes: string[];
} {
  const notes: string[] = [];
  const periodEnd =
    typeof sub.current_period_end === "number" ? sub.current_period_end : null;
  const canceledAt = typeof sub.canceled_at === "number" ? sub.canceled_at : null;
  const endedAt = typeof sub.ended_at === "number" ? sub.ended_at : null;
  const cancelAt = typeof sub.cancel_at === "number" ? sub.cancel_at : null;
  const eventUnix = options?.eventUnix ?? null;
  const paidThrough = options?.paidThroughUnix ?? periodEnd;

  if (sub.cancel_at_period_end) {
    return {
      kind: "cancel_at_period_end",
      effectiveUnix: cancelAt ?? periodEnd,
      notes: ["cancel_at_period_end=true — preserve paid-through"],
    };
  }

  // Natural end: ended/canceled at or after period end (within 2 days slack)
  const endAnchor = endedAt ?? canceledAt ?? eventUnix;
  if (
    periodEnd != null &&
    endAnchor != null &&
    endAnchor + 2 * 86400 >= periodEnd
  ) {
    return {
      kind: "scheduled_end",
      effectiveUnix: periodEnd,
      notes: ["Subscription ended at/after period end — do not shorten paid-through"],
    };
  }

  // Immediate: clearly canceled before period end and before paid-through
  if (
    (sub.status === "canceled" || endedAt != null || canceledAt != null) &&
    periodEnd != null &&
    endAnchor != null &&
    endAnchor + 3600 < periodEnd &&
    (paidThrough == null || endAnchor + 3600 < paidThrough)
  ) {
    notes.push("Immediate cancellation before period end");
    return {
      kind: "immediate",
      effectiveUnix: endAnchor,
      notes,
    };
  }

  if (sub.status === "canceled" || endedAt != null) {
    notes.push("Cancellation timing ambiguous — no automatic clamp");
    return { kind: "ambiguous", effectiveUnix: null, notes };
  }

  return { kind: "none", effectiveUnix: null, notes };
}

function snapshotSub(sub: Stripe.Subscription): StripeSubscriptionSnapshot {
  const s = sub as unknown as {
    current_period_end?: number;
    cancel_at?: number | null;
    canceled_at?: number | null;
    ended_at?: number | null;
    cancel_at_period_end?: boolean;
    items?: { data?: Array<{ current_period_end?: number }> };
  };
  const itemEnd = s.items?.data?.[0]?.current_period_end;
  return {
    id: sub.id,
    status: sub.status,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    cancelAtUnix: typeof s.cancel_at === "number" ? s.cancel_at : null,
    canceledAtUnix: typeof s.canceled_at === "number" ? s.canceled_at : null,
    endedAtUnix: typeof s.ended_at === "number" ? s.ended_at : null,
    currentPeriodEndUnix:
      typeof s.current_period_end === "number"
        ? s.current_period_end
        : typeof itemEnd === "number"
          ? itemEnd
          : null,
  };
}

/**
 * Derive legitimate paid-through entitlement for one Stripe customer.
 * Fully refunded qualifying invoices are excluded from the max period end.
 * Partial refunds remain contributing (manual review elsewhere).
 */
export async function calculateStripeEntitlement(input: {
  stripe: StripeInvoiceListClient;
  stripeCustomerId: string;
  membershipPriceIds?: Set<string>;
  nowUnix?: number;
  includeSubscriptions?: boolean;
}): Promise<StripeEntitlementResult> {
  const cus = input.stripeCustomerId.trim();
  const nowUnix = input.nowUnix ?? Math.floor(Date.now() / 1000);
  const allow = membershipAllowlist(input.membershipPriceIds);
  const notes: string[] = [];

  if (!cus.startsWith("cus_")) {
    return {
      stripeCustomerId: cus,
      hasEntitlementNow: false,
      paidThroughUnix: null,
      paidThroughIso: null,
      referenceUnix: nowUnix,
      qualifyingPayments: [],
      contributingInvoiceIds: [],
      fullyRefundedInvoiceIds: [],
      partiallyRefundedInvoiceIds: [],
      subscriptionIds: [],
      priceIds: [],
      primarySubscription: null,
      cancellationKind: "none",
      effectiveCancellationUnix: null,
      notes: ["Invalid Stripe Customer ID"],
      confidence: "low",
    };
  }

  if (allow.size === 0) {
    notes.push("No native membership price_ allowlist configured — fail closed");
  }

  const invoices = await listPaidInvoicesForCustomer(input.stripe, cus);
  const qualifyingPayments: QualifyingPaymentPeriod[] = [];
  const priceIds = new Set<string>();
  const subscriptionIds = new Set<string>();

  for (const inv of invoices) {
    const invoiceId = inv.id;
    if (!invoiceId) continue;
    const lines = await listAllInvoiceLines(input.stripe, invoiceId);
    const qPrices = getQualifyingMembershipPriceIds(lines, allow);
    if (qPrices.length === 0) continue;
    const periodEndUnix = getMembershipPeriodEnd(lines, allow);
    if (periodEndUnix == null) continue;

    for (const p of qPrices) priceIds.add(p);
    const subId = invoiceSubscriptionId(inv);
    if (subId) subscriptionIds.add(subId);

    let refundKind: RefundKind = "none";
    let amountRefunded = 0;
    const amountPaid = invoiceAmountPaid(inv);
    const chargeId = invoiceChargeId(inv);

    if (chargeId && input.stripe.charges?.retrieve) {
      try {
        const charge = await input.stripe.charges.retrieve(chargeId);
        refundKind = classifyChargeRefundFromStripe(charge);
        amountRefunded =
          typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
      } catch {
        notes.push(`Could not retrieve charge ${chargeId}`);
        refundKind = "unknown";
      }
    } else {
      // Fallback: invoice amount_remaining / post-payment refunds not always on invoice
      const invRefunded = (inv as unknown as { amount_remaining?: number }).amount_remaining;
      if (typeof invRefunded === "number" && invRefunded > 0 && amountPaid > 0) {
        // Not reliable alone
      }
    }

    const contributes = refundKind !== "full";
    qualifyingPayments.push({
      invoiceId,
      chargeId,
      subscriptionId: subId,
      priceIds: qPrices,
      periodEndUnix,
      periodEndIso: new Date(periodEndUnix * 1000).toISOString(),
      amountPaid,
      amountRefunded,
      refundKind,
      contributesToEntitlement: contributes,
    });
  }

  const contributing = qualifyingPayments.filter((p) => p.contributesToEntitlement);
  let paidThroughUnix: number | null = null;
  for (const p of contributing) {
    if (paidThroughUnix == null || p.periodEndUnix > paidThroughUnix) {
      paidThroughUnix = p.periodEndUnix;
    }
  }

  let primarySubscription: StripeSubscriptionSnapshot | null = null;
  let cancellationKind: CancellationKind = "none";
  let effectiveCancellationUnix: number | null = null;

  if (input.includeSubscriptions !== false && input.stripe.subscriptions?.list) {
    try {
      const subs = await input.stripe.subscriptions.list({
        customer: cus,
        status: "all",
        limit: 20,
      });
      const ranked = [...subs.data].sort((a, b) => {
        const rank = (s: Stripe.Subscription) =>
          s.status === "active" || s.status === "trialing"
            ? 0
            : s.status === "past_due"
              ? 1
              : 2;
        return rank(a) - rank(b);
      });
      if (ranked[0]) {
        primarySubscription = snapshotSub(ranked[0]);
        const cls = classifySubscriptionCancellation(
          {
            status: primarySubscription.status,
            cancel_at_period_end: primarySubscription.cancelAtPeriodEnd,
            cancel_at: primarySubscription.cancelAtUnix,
            canceled_at: primarySubscription.canceledAtUnix,
            ended_at: primarySubscription.endedAtUnix,
            current_period_end: primarySubscription.currentPeriodEndUnix,
          },
          { paidThroughUnix }
        );
        cancellationKind = cls.kind;
        effectiveCancellationUnix = cls.effectiveUnix;
        notes.push(...cls.notes);

        // Immediate cancel clamps paid-through for entitlement-now calculation
        if (
          cls.kind === "immediate" &&
          cls.effectiveUnix != null &&
          paidThroughUnix != null &&
          cls.effectiveUnix < paidThroughUnix
        ) {
          paidThroughUnix = cls.effectiveUnix;
          notes.push("Clamped paid-through to immediate cancellation time");
        }

        // Active subscriptions are entitled through their CURRENT period end even
        // when the renewal invoice is still open/draft — Stripe keeps the sub active
        // (member keeps access) until dunning fails. Without this, a member whose
        // renewal hasn't paid yet would look expired from paid invoices alone.
        // past_due / unpaid / trialing are intentionally NOT promoted (see access rules).
        if (
          primarySubscription.status === "active" &&
          primarySubscription.currentPeriodEndUnix != null &&
          (paidThroughUnix == null ||
            primarySubscription.currentPeriodEndUnix > paidThroughUnix)
        ) {
          paidThroughUnix = primarySubscription.currentPeriodEndUnix;
          notes.push(
            "Active subscription — paid-through promoted to current period end (renewal invoice may still be pending)"
          );
        }
      }
      if (subs.data.filter((s) => s.status === "active" || s.status === "trialing").length > 1) {
        notes.push("Multiple active/trialing subscriptions");
      }
    } catch {
      notes.push("Could not list subscriptions");
    }
  }

  const hasEntitlementNow =
    paidThroughUnix != null && paidThroughUnix >= nowUnix;

  let confidence: "high" | "medium" | "low" = "high";
  if (allow.size === 0) confidence = "low";
  else if (notes.some((n) => /ambiguous|Could not/i.test(n))) confidence = "medium";
  else if (qualifyingPayments.some((p) => p.refundKind === "unknown")) confidence = "medium";

  return {
    stripeCustomerId: cus,
    hasEntitlementNow,
    paidThroughUnix,
    paidThroughIso:
      paidThroughUnix != null
        ? new Date(paidThroughUnix * 1000).toISOString()
        : null,
    referenceUnix: nowUnix,
    qualifyingPayments,
    contributingInvoiceIds: contributing.map((p) => p.invoiceId),
    fullyRefundedInvoiceIds: qualifyingPayments
      .filter((p) => p.refundKind === "full")
      .map((p) => p.invoiceId),
    partiallyRefundedInvoiceIds: qualifyingPayments
      .filter((p) => p.refundKind === "partial")
      .map((p) => p.invoiceId),
    subscriptionIds: [...subscriptionIds],
    priceIds: [...priceIds],
    primarySubscription,
    cancellationKind,
    effectiveCancellationUnix,
    notes,
    confidence,
  };
}

/**
 * Desired Service access until ISO from entitlement (null = clear / no verified access).
 */
export function desiredServiceAccessUntilIso(
  entitlement: StripeEntitlementResult
): string | null {
  return entitlement.paidThroughIso;
}
