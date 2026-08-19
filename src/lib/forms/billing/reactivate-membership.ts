/**
 * Reactivate membership for an authenticated member.
 * Resolves Stripe customer/subscription server-side from Memberstack id.
 * Stripe remains source of truth; Airtable is updated after Stripe succeeds.
 */
import type Stripe from "stripe";
import {
  getStripeClient,
  getConfiguredMemberstackPlanId,
} from "@/lib/integrations/stripe";
import {
  getMemberstackPlanIdForStripePrice,
  getReactivationPrice,
} from "@/lib/billing/catalog";
import { calculateStripeEntitlement } from "@/lib/billing/stripe-entitlement";
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

/**
 * Price used whenever a NEW membership/subscription is created (rejoin path).
 * Resolved from the billing catalog (current reactivation price). Must be a
 * Stripe `price_…`; never a legacy/grandfathered price. The old allowlist
 * (`STRIPE_MEMBERSHIP_PRICE_IDS`) is intentionally NOT used here — it may
 * contain legacy prices old members are still paying.
 * `STRIPE_REACTIVATION_PRICE_ID` remains a migration fallback only.
 */
function resolveStripePriceId(): string {
  const envPrice = (process.env.STRIPE_REACTIVATION_PRICE_ID || "").trim();
  const catalogPrice = getReactivationPrice()?.stripePriceId?.trim() || "";
  if (catalogPrice.startsWith("price_")) return catalogPrice;
  if (envPrice.startsWith("price_")) return envPrice;
  return "";
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
  const plan =
    (subPrice ? getMemberstackPlanIdForStripePrice(subPrice) : "") ||
    getConfiguredMemberstackPlanId() ||
    subPrice;
  return { subPrice, plan };
}

function isScheduledCancel(s: Stripe.Subscription): boolean {
  if (s.cancel_at_period_end) return true;
  if (typeof s.cancel_at === "number" && s.cancel_at * 1000 > Date.now()) return true;
  return false;
}

/**
 * A member whose membership payment was fully refunded loses grandfathered
 * pricing: they must NOT reverse an old cancellation and recover the old price.
 *
 * Primary signal is the Airtable Payment=Refunded state written by the Stripe
 * webhook on `charge.refunded`. We strengthen it with live Stripe data (the
 * most recent qualifying membership payment is fully refunded) so a missed
 * webhook still cannot silently recover an old price.
 */
function paymentFieldIsRefunded(fields: Record<string, unknown>): boolean {
  return fieldStr(fields, MEMBER_FIELDS.payment).toLowerCase() === "refunded";
}

async function latestMembershipPaymentFullyRefunded(
  stripe: Stripe,
  stripeCustomerId: string
): Promise<boolean> {
  try {
    const entitlement = await calculateStripeEntitlement({
      stripe,
      stripeCustomerId,
      includeSubscriptions: false,
    });
    const latest = [...entitlement.qualifyingPayments].sort(
      (a, b) => b.periodEndUnix - a.periodEndUnix
    )[0];
    return Boolean(latest && latest.refundKind === "full");
  } catch {
    return false;
  }
}

async function isFullyRefunded(input: {
  fields: Record<string, unknown>;
  stripe: Stripe;
  stripeCustomerId: string;
}): Promise<boolean> {
  if (paymentFieldIsRefunded(input.fields)) return true;
  return latestMembershipPaymentFullyRefunded(input.stripe, input.stripeCustomerId);
}

/**
 * Safely end an old (refunded) subscription so rejoining never creates a second
 * active subscription. Best-effort: Stripe already refunded the charge, so this
 * only tears down the orphaned subscription object.
 */
async function safelyEndSubscription(stripe: Stripe, subscriptionId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "reactivate_end_refunded_sub_failed",
        subscriptionId,
        error: e instanceof Error ? e.message : String(e),
      })
    );
  }
}

/**
 * Undo a scheduled end without charging.
 * Stripe rejects setting cancel_at and cancel_at_period_end in the same request.
 */
async function reverseScheduledCancellation(
  stripe: Stripe,
  sub: Stripe.Subscription
): Promise<Stripe.Subscription> {
  // Path A — cancel_at_period_end (most common via Customer Portal)
  if (sub.cancel_at_period_end) {
    try {
      return await stripe.subscriptions.update(sub.id, {
        cancel_at_period_end: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        JSON.stringify({
          event: "reactivate_reverse_cancel_at_period_end_failed",
          subscriptionId: sub.id,
          error: msg,
        })
      );
      throw new FormsError(
        "STRIPE_API_FAILED",
        "Stripe could not remove the scheduled cancellation. Please try Manage billing, or try again in a moment.",
        { status: 502, retryable: true }
      );
    }
  }

  // Path B — fixed cancel_at timestamp (Memberstack / some portal configs)
  if (typeof sub.cancel_at === "number" && sub.cancel_at * 1000 > Date.now()) {
    try {
      // Stripe clears cancel_at when cancel_at_period_end is set false on some API versions;
      // empty-string clear is accepted by the REST API.
      return await stripe.subscriptions.update(sub.id, {
        cancel_at: "" as unknown as number,
      });
    } catch {
      try {
        return await stripe.subscriptions.update(sub.id, {
          cancel_at_period_end: false,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          JSON.stringify({
            event: "reactivate_reverse_cancel_at_failed",
            subscriptionId: sub.id,
            error: msg,
          })
        );
        throw new FormsError(
          "STRIPE_API_FAILED",
          "Stripe could not remove the scheduled cancellation. Please try Manage billing, or try again in a moment.",
          { status: 502, retryable: true }
        );
      }
    }
  }

  // Already not scheduled — return as-is
  return sub;
}

async function syncReactivateBilling(input: {
  memberstackId: string;
  stripeCustomerId: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  try {
    await applyTrustedPaymentByMemberstackId({
      memberstackId: input.memberstackId,
      stripeCustomerId: input.stripeCustomerId,
      patch: input.patch,
    });
  } catch (e) {
    // Stripe already succeeded — do not fail the member-facing flow.
    // Webhook / next billing-status pull will reconcile Airtable.
    console.error(
      JSON.stringify({
        event: "reactivate_airtable_sync_failed",
        memberstackId: input.memberstackId,
        error: e instanceof Error ? e.message : String(e),
      })
    );
  }
}

export async function reactivateMembershipForMember(input: {
  memberstackId: string;
  /** Optional email / MS raw for customer resolution fallback */
  email?: string;
  memberstackRaw?: Record<string, unknown> | null;
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
  let stripeCustomerId = fieldStr(fields, MEMBER_FIELDS.stripeCustomerId);

  // Fallback: Memberstack raw → unique Stripe email (same idea as billing-status)
  if (!stripeCustomerId.startsWith("cus_")) {
    try {
      const { extractStripeCustomerIdFromMemberstackRaw } = await import(
        "@/lib/forms/billing/confirm-checkout"
      );
      if (input.memberstackRaw) {
        const fromMs = extractStripeCustomerIdFromMemberstackRaw(input.memberstackRaw);
        if (fromMs.startsWith("cus_")) stripeCustomerId = fromMs;
      }
      if (!stripeCustomerId.startsWith("cus_")) {
        const email =
          (input.email || "").trim().toLowerCase() ||
          fieldStr(fields, MEMBER_FIELDS.email).toLowerCase();
        if (email.includes("@")) {
          const stripe = getStripeClient();
          const found = await stripe.customers.list({ email, limit: 5 });
          const live = found.data.filter((c) => !c.deleted);
          if (live.length === 1 && live[0].id.startsWith("cus_")) {
            stripeCustomerId = live[0].id;
          }
        }
      }
    } catch {
      /* keep empty */
    }
  }

  if (!stripeCustomerId.startsWith("cus_")) {
    return failResult({
      status: "no_stripe_customer",
      reason:
        "No Stripe customer on file yet. Use Manage billing or complete checkout once to save a card, then reactivate.",
      requiresPaymentMethod: true,
    });
  }

  const stripe = getStripeClient();

  // Prefer stored subscription id first (same as billing-status)
  const storedSubId = fieldStr(fields, MEMBER_FIELDS.stripeSubscriptionId);
  let subsList: Stripe.Subscription[] = [];
  try {
    if (storedSubId.startsWith("sub_")) {
      try {
        const direct = await stripe.subscriptions.retrieve(storedSubId);
        if (direct && !("deleted" in direct && (direct as { deleted?: boolean }).deleted)) {
          subsList = [direct];
        }
      } catch {
        /* fall through */
      }
    }
    const listed = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 15,
    });
    for (const s of listed.data) {
      if (!subsList.some((x) => x.id === s.id)) subsList.push(s);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      JSON.stringify({ event: "reactivate_list_subs_failed", error: msg })
    );
    throw new FormsError(
      "STRIPE_API_FAILED",
      "Could not load your Stripe subscription. Please try again in a moment.",
      { status: 502, retryable: true }
    );
  }

  /**
   * Reactivation charge rules (do not double-bill):
   * 1) active/trialing && !scheduled cancel → already live, no charge
   * 2) active/trialing && scheduled cancel  → reverse cancel only, no charge
   * 3) past_due / unpaid / incomplete        → payment-method / portal path
   * 4) canceled (ended)                      → new subscription (or portal if no card)
   *
   * Fully refunded members lose grandfathered pricing: rules 1–3 are skipped and
   * they always rejoin via a new subscription at the NEW price (rule 4).
   */
  const fullRefunded = await isFullyRefunded({
    fields,
    stripe,
    stripeCustomerId,
  });

  const live = subsList.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") && !isScheduledCancel(s)
  );
  if (!fullRefunded && live) {
    const { plan, subPrice } = commerceIds(live, "");
    const next = periodEndIso(live);
    await syncReactivateBilling({
      memberstackId: msId,
      stripeCustomerId,
      patch: {
        [MEMBER_FIELDS.stripeSubscriptionId]: live.id,
        [MEMBER_FIELDS.stripeSubscriptionStatus]: live.status,
        [MEMBER_FIELDS.stripeCustomerId]: stripeCustomerId,
        [MEMBER_FIELDS.stripePriceId]: subPrice,
        [MEMBER_FIELDS.memberstackPlanId]:
          plan || fieldStr(fields, MEMBER_FIELDS.memberstackPlanId),
        ["Paid Plans (price ids)"]: formatPaidPlansText([subPrice, plan]),
        [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
        [MEMBER_FIELDS.cancellationEffectiveAt]: "",
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
  const pendingCancel = subsList.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") && isScheduledCancel(s)
  );
  if (!fullRefunded && pendingCancel) {
    const updated = await reverseScheduledCancellation(stripe, pendingCancel);
    const { subPrice, plan } = commerceIds(updated, "");
    const next = periodEndIso(updated);
    await syncReactivateBilling({
      memberstackId: msId,
      stripeCustomerId,
      patch: {
        [MEMBER_FIELDS.stripeSubscriptionId]: updated.id,
        [MEMBER_FIELDS.stripeSubscriptionStatus]: updated.status,
        [MEMBER_FIELDS.stripeCustomerId]: stripeCustomerId,
        [MEMBER_FIELDS.stripePriceId]: subPrice,
        [MEMBER_FIELDS.memberstackPlanId]: plan || "",
        ["Paid Plans (price ids)"]: formatPaidPlansText([subPrice]),
        [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
        [MEMBER_FIELDS.cancellationEffectiveAt]: "",
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
  const problem = subsList.find((s) =>
    ["past_due", "unpaid", "incomplete"].includes(s.status)
  );
  if (!fullRefunded && problem) {
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

  // Fully refunded: safely end any still-live old subscription so rejoining never
  // creates a second active subscription, then rejoin at the NEW price below.
  if (fullRefunded) {
    for (const s of subsList) {
      if (
        ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(s.status)
      ) {
        await safelyEndSubscription(stripe, s.id);
      }
    }
  }

  // Subscription has ended (canceled / incomplete_expired / etc.) — new paid sub
  // at the current price. Never reuse a historical/grandfathered price.
  const priceId = resolveStripePriceId();
  if (!priceId) {
    return failResult({
      status: "no_price",
      reason:
        "No Stripe membership price configured. Set BILLING_CATALOG_JSON (or STRIPE_REACTIVATION_PRICE_ID=price_…)",
    });
  }

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
      [MEMBER_FIELDS.stripePriceId]: subPrice,
      [MEMBER_FIELDS.memberstackPlanId]: plan || "",
      ["Paid Plans (price ids)"]: formatPaidPlansText([subPrice, plan]),
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
