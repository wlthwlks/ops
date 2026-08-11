/**
 * Reactivate membership for an authenticated member.
 * Resolves Stripe customer/subscription server-side from Memberstack id.
 * Stripe remains source of truth; Airtable is updated after Stripe succeeds.
 */
import type Stripe from "stripe";
import {
  getStripeClient,
  getConfiguredMembershipPriceIds,
  getConfiguredMemberstackPlanId,
} from "@/lib/integrations/stripe";
import {
  applyTrustedPaymentByMemberstackId,
  findMemberByMemberstackId,
} from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { FormsError } from "@/lib/forms/errors";
import { formatPaidPlansText } from "@/lib/billing/service-access-sync";

export type ReactivateResult = {
  success: boolean;
  status: string;
  reason: string;
  /** Alias of reason for clients that only read `message`. */
  message: string;
  subscriptionId?: string;
  subscriptionStatus?: string;
  paymentMethodReused?: boolean;
  /**
   * True only when a new Stripe subscription was created (immediate charge path).
   * False for already-active and cancel_at_period_end reverse (no new charge).
   */
  charged?: boolean;
  /** ISO date (YYYY-MM-DD) of next renewal / period end when known. */
  nextRenewalDate?: string | null;
  /** Client should open Stripe Customer Portal / payment-method flow. */
  requiresPaymentMethod?: boolean;
  currentPeriodEnd?: string | null;
};

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function periodEndIso(sub: Stripe.Subscription): string | null {
  const itemEnd = sub.items?.data?.[0]?.current_period_end;
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const unix = typeof itemEnd === "number" ? itemEnd : typeof top === "number" ? top : null;
  if (unix == null) return null;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function okResult(
  partial: Omit<ReactivateResult, "success" | "message"> & { reason: string }
): ReactivateResult {
  return {
    success: true,
    message: partial.reason,
    ...partial,
  };
}

function failResult(
  partial: Omit<ReactivateResult, "success" | "message"> & { reason: string }
): ReactivateResult {
  return {
    success: false,
    message: partial.reason,
    charged: false,
    ...partial,
  };
}

async function resolveStripePriceId(
  stripe: Stripe,
  customerId: string
): Promise<string> {
  const configured = [...getConfiguredMembershipPriceIds()].filter((id) =>
    id.startsWith("price_")
  );
  if (configured[0]) return configured[0];
  const envPrice = (process.env.STRIPE_REACTIVATION_PRICE_ID || "").trim();
  if (envPrice.startsWith("price_")) return envPrice;

  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 15,
  });
  for (const sub of subs.data) {
    const pid = sub.items.data[0]?.price?.id;
    if (pid?.startsWith("price_")) return pid;
  }

  const prices = await stripe.prices.list({ active: true, limit: 30 });
  const preferred =
    prices.data.find((p) => p.unit_amount === 4500) ||
    prices.data.find((p) => p.unit_amount === 1500) ||
    prices.data[0];
  return preferred?.id?.startsWith("price_") ? preferred.id : "";
}

/** True when Stripe customer has a usable default or listed card. */
export async function customerHasPaymentMethod(
  stripeCustomerId: string
): Promise<boolean> {
  const id = stripeCustomerId.trim();
  if (!id.startsWith("cus_")) return false;
  try {
    const stripe = getStripeClient();
    const pm = await resolveDefaultPaymentMethodId(stripe, id);
    return Boolean(pm);
  } catch {
    return false;
  }
}

async function resolveDefaultPaymentMethodId(
  stripe: Stripe,
  customerId: string
): Promise<string> {
  const customer = (await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method"],
  })) as Stripe.Customer;
  if ("deleted" in customer && customer.deleted) {
    throw new FormsError("STRIPE_CUSTOMER_CONFLICT", "Stripe customer was deleted", {
      status: 400,
    });
  }

  const def = customer.invoice_settings?.default_payment_method;
  if (typeof def === "string" && def.startsWith("pm_")) return def;
  if (def && typeof def === "object" && "id" in def && typeof def.id === "string") {
    return def.id;
  }

  const cards = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 5,
  });
  if (cards.data[0]?.id) return cards.data[0].id;

  const src = customer.default_source;
  if (typeof src === "string" && (src.startsWith("card_") || src.startsWith("pm_"))) {
    return src;
  }

  return "";
}

function commerceIds(sub: Stripe.Subscription, fallbackPriceId: string) {
  const subPrice =
    sub.items.data[0]?.price?.id?.startsWith("price_")
      ? sub.items.data[0].price.id
      : fallbackPriceId;
  const plan = getConfiguredMemberstackPlanId() || subPrice;
  return { subPrice, plan };
}

export async function reactivateMembershipForMember(input: {
  memberstackId: string;
}): Promise<ReactivateResult> {
  const msId = input.memberstackId.trim();
  if (!msId) {
    throw new FormsError("MEMBERSTACK_API_FAILED", "Missing member id", { status: 401 });
  }

  const rows = await findMemberByMemberstackId(msId);
  if (rows.length === 0) {
    throw new FormsError("AIRTABLE_MEMBER_NOT_FOUND", "Member not found", { status: 404 });
  }
  if (rows.length > 1) {
    throw new FormsError("AIRTABLE_DUPLICATE_MEMBER", "Duplicate Memberstack ID", {
      status: 409,
    });
  }

  const fields = rows[0].fields;
  const stripeCustomerId = fieldStr(fields, MEMBER_FIELDS.stripeCustomerId);
  if (!stripeCustomerId.startsWith("cus_")) {
    return failResult({
      status: "no_stripe_customer",
      reason:
        "No Stripe customer on file yet. Complete checkout once to save a card, then you can reactivate with one click.",
      requiresPaymentMethod: true,
    });
  }

  const stripe = getStripeClient();
  const priceId = await resolveStripePriceId(stripe, stripeCustomerId);
  if (!priceId) {
    return failResult({
      status: "no_price",
      reason:
        "No Stripe membership price configured. Set STRIPE_REACTIVATION_PRICE_ID=price_…",
    });
  }

  const subs = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 15,
  });

  /**
   * Reactivation charge rules (do not double-bill):
   * 1) active/trialing && !cancel_at_period_end → already live, no charge
   * 2) active/trialing && cancel_at_period_end  → only clear cancel flag, no charge
   *    (payment method not required to undo scheduled cancel)
   * 3) past_due / unpaid / incomplete          → payment-method / portal path
   * 4) canceled (ended)                        → new subscription (or portal if no card)
   */
  const isScheduledCancel = (s: Stripe.Subscription) =>
    Boolean(s.cancel_at_period_end) ||
    (typeof s.cancel_at === "number" && s.cancel_at * 1000 > Date.now());

  const live = subs.data.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") && !isScheduledCancel(s)
  );
  if (live) {
    const { plan } = commerceIds(live, priceId);
    const next = periodEndIso(live);
    await applyTrustedPaymentByMemberstackId({
      memberstackId: msId,
      stripeCustomerId,
      patch: {
        [MEMBER_FIELDS.stripeSubscriptionId]: live.id,
        [MEMBER_FIELDS.stripeSubscriptionStatus]: live.status,
        [MEMBER_FIELDS.stripePriceId]: plan,
        [MEMBER_FIELDS.memberstackPlanId]:
          getConfiguredMemberstackPlanId() ||
          fieldStr(fields, MEMBER_FIELDS.memberstackPlanId),
        ["Paid Plans (price ids)"]: formatPaidPlansText([plan || priceId]),
        [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
        ...(next ? { [MEMBER_FIELDS.serviceAccessUntil]: next } : {}),
      },
    });
    return okResult({
      status: "already_active",
      reason: "Membership is already active",
      subscriptionId: live.id,
      subscriptionStatus: live.status,
      paymentMethodReused: true,
      charged: false,
      nextRenewalDate: next,
      currentPeriodEnd: next,
    });
  }

  // Still in paid period with cancel scheduled — reverse only, never new Checkout.
  // Do not require a card: undoing cancel_at_period_end / cancel_at does not charge.
  const pendingCancel = subs.data.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") && isScheduledCancel(s)
  );
  if (pendingCancel) {
    const updated = await stripe.subscriptions.update(pendingCancel.id, {
      cancel_at_period_end: false,
      // Clear a fixed cancel_at timestamp if Memberstack/portal set one
      cancel_at: null,
    });
    const { subPrice, plan } = commerceIds(updated, priceId);
    const next = periodEndIso(updated);
    await applyTrustedPaymentByMemberstackId({
      memberstackId: msId,
      stripeCustomerId,
      patch: {
        [MEMBER_FIELDS.stripeSubscriptionId]: updated.id,
        [MEMBER_FIELDS.stripeSubscriptionStatus]: updated.status,
        [MEMBER_FIELDS.stripePriceId]: plan || subPrice || priceId,
        [MEMBER_FIELDS.memberstackPlanId]: getConfiguredMemberstackPlanId() || "",
        ["Paid Plans (price ids)"]: formatPaidPlansText([
          getConfiguredMemberstackPlanId() || priceId,
        ]),
        [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
        // Preserve existing paid-through; only set when Stripe gives a period end.
        ...(next ? { [MEMBER_FIELDS.serviceAccessUntil]: next } : {}),
      },
    });
    return okResult({
      status: "cancellation_reversed",
      reason:
        "Your membership is active again. You will not be charged today." +
        (next ? ` Your next scheduled renewal is ${next}.` : ""),
      subscriptionId: updated.id,
      subscriptionStatus: updated.status,
      paymentMethodReused: true,
      charged: false,
      nextRenewalDate: next,
      currentPeriodEnd: next,
    });
  }

  // Payment problems — do not create a second subscription; send to payment method flow.
  const problem = subs.data.find((s) =>
    ["past_due", "unpaid", "incomplete"].includes(s.status)
  );
  if (problem) {
    const pmId = await resolveDefaultPaymentMethodId(stripe, stripeCustomerId);
    if (!pmId) {
      return failResult({
        status: "no_payment_method",
        reason:
          "Add a payment method to continue your membership. Use Manage billing to add a card, then try again.",
        requiresPaymentMethod: true,
        subscriptionId: problem.id,
        subscriptionStatus: problem.status,
      });
    }
    // Card exists but invoice may still need attention — portal is safest.
    return failResult({
      status: "payment_problem",
      reason:
        "Your membership has a payment issue. Use Manage billing to update your card or pay the open invoice.",
      requiresPaymentMethod: true,
      subscriptionId: problem.id,
      subscriptionStatus: problem.status,
      paymentMethodReused: true,
    });
  }

  // Subscription has ended (canceled / incomplete_expired / etc.) — new paid sub.
  const pmId = await resolveDefaultPaymentMethodId(stripe, stripeCustomerId);
  if (!pmId) {
    return failResult({
      status: "no_payment_method",
      reason:
        "Add a payment method to continue your membership. Use Manage billing to add a card, then reactivate.",
      requiresPaymentMethod: true,
    });
  }

  try {
    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: pmId },
    });
  } catch {
    /* continue — still pass default_payment_method on sub */
  }

  let created: Stripe.Subscription;
  try {
    created = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: priceId }],
      default_payment_method: pmId,
      payment_behavior: "error_if_incomplete",
      expand: ["latest_invoice.payment_intent"],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Subscription create failed";
    throw new FormsError("STRIPE_PAYMENT_FAILED", msg, { status: 402 });
  }

  const { subPrice, plan } = commerceIds(created, priceId);
  const next = periodEndIso(created);

  await applyTrustedPaymentByMemberstackId({
    memberstackId: msId,
    stripeCustomerId,
    patch: {
      [MEMBER_FIELDS.stripeSubscriptionId]: created.id,
      [MEMBER_FIELDS.stripeSubscriptionStatus]: created.status,
      [MEMBER_FIELDS.stripePriceId]: plan,
      [MEMBER_FIELDS.memberstackPlanId]: getConfiguredMemberstackPlanId() || plan,
      ["Paid Plans (price ids)"]: formatPaidPlansText([plan, subPrice]),
      [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
      ...(next ? { [MEMBER_FIELDS.serviceAccessUntil]: next } : {}),
    },
  });

  return okResult({
    status: "reactivated",
    reason: "Membership reactivated using your card on file",
    subscriptionId: created.id,
    subscriptionStatus: created.status,
    paymentMethodReused: true,
    charged: true,
    nextRenewalDate: next,
    currentPeriodEnd: next,
  });
}
