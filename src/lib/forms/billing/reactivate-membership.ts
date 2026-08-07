/**
 * Reactivate membership for an authenticated member using their Stripe customer
 * and the last card on file (no Customer Portal).
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
  subscriptionId?: string;
  subscriptionStatus?: string;
  paymentMethodReused?: boolean;
  /**
   * True only when a new Stripe subscription was created (immediate charge path).
   * False for already-active and cancel_at_period_end reverse (no new charge).
   */
  charged?: boolean;
};

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

async function resolveStripePriceId(
  stripe: Stripe,
  customerId: string
): Promise<string> {
  // 1) Explicit env Stripe price_ ids
  const configured = [...getConfiguredMembershipPriceIds()].filter((id) =>
    id.startsWith("price_")
  );
  if (configured[0]) return configured[0];
  const envPrice = (process.env.STRIPE_REACTIVATION_PRICE_ID || "").trim();
  if (envPrice.startsWith("price_")) return envPrice;

  // 2) Last subscription on this customer
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 15,
  });
  for (const sub of subs.data) {
    const pid = sub.items.data[0]?.price?.id;
    if (pid?.startsWith("price_")) return pid;
  }

  // 3) Active prices — prefer $45 (4500) WLTH quarterly, else first active
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

  // Legacy default_source
  const src = customer.default_source;
  if (typeof src === "string" && (src.startsWith("card_") || src.startsWith("pm_"))) {
    return src;
  }

  return "";
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
    return {
      success: false,
      status: "no_stripe_customer",
      reason:
        "No Stripe customer on file yet. Complete checkout once to save a card, then you can reactivate with one click.",
      charged: false,
    };
  }

  const stripe = getStripeClient();
  const priceId = await resolveStripePriceId(stripe, stripeCustomerId);
  if (!priceId) {
    return {
      success: false,
      status: "no_price",
      reason: "No Stripe membership price configured. Set STRIPE_REACTIVATION_PRICE_ID=price_…",
      charged: false,
    };
  }

  const subs = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 15,
  });

  /**
   * Reactivation charge rules (do not double-bill):
   * 1) active/trialing && !cancel_at_period_end → already live, no Checkout/charge
   * 2) active/trialing && cancel_at_period_end  → only clear cancel flag, no charge
   * 3) canceled (ended)                        → new subscription (or Checkout if no card)
   */
  const live = subs.data.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") && !s.cancel_at_period_end
  );
  if (live) {
    await applyTrustedPaymentByMemberstackId({
      memberstackId: msId,
      stripeCustomerId,
      patch: {
        [MEMBER_FIELDS.stripeSubscriptionId]: live.id,
        [MEMBER_FIELDS.stripeSubscriptionStatus]: live.status,
        [MEMBER_FIELDS.stripePriceId]:
          getConfiguredMemberstackPlanId() ||
          live.items.data[0]?.price?.id ||
          priceId,
        [MEMBER_FIELDS.memberstackPlanId]:
          getConfiguredMemberstackPlanId() ||
          fieldStr(fields, MEMBER_FIELDS.memberstackPlanId),
        ["Paid Plans (price ids)"]: formatPaidPlansText([
          getConfiguredMemberstackPlanId() || priceId,
        ]),
        [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
      },
    });
    return {
      success: true,
      status: "already_active",
      reason: "Membership is already active",
      subscriptionId: live.id,
      subscriptionStatus: live.status,
      paymentMethodReused: true,
      charged: false,
    };
  }

  // Still in paid period with cancel scheduled — reverse only, never new Checkout.
  const pendingCancel = subs.data.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") && s.cancel_at_period_end
  );
  if (pendingCancel) {
    const updated = await stripe.subscriptions.update(pendingCancel.id, {
      cancel_at_period_end: false,
    });
    await applyTrustedPaymentByMemberstackId({
      memberstackId: msId,
      stripeCustomerId,
      patch: {
        [MEMBER_FIELDS.stripeSubscriptionId]: updated.id,
        [MEMBER_FIELDS.stripeSubscriptionStatus]: updated.status,
        [MEMBER_FIELDS.stripePriceId]:
          getConfiguredMemberstackPlanId() ||
          updated.items.data[0]?.price?.id ||
          priceId,
        [MEMBER_FIELDS.memberstackPlanId]: getConfiguredMemberstackPlanId() || "",
        ["Paid Plans (price ids)"]: formatPaidPlansText([
          getConfiguredMemberstackPlanId() || priceId,
        ]),
        [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
      },
    });
    return {
      success: true,
      status: "cancellation_reversed",
      reason: "Scheduled cancellation removed — membership stays active on your saved card",
      subscriptionId: updated.id,
      subscriptionStatus: updated.status,
      paymentMethodReused: true,
      charged: false,
    };
  }

  // Subscription has ended (canceled / incomplete_expired / etc.) — new paid sub.
  const pmId = await resolveDefaultPaymentMethodId(stripe, stripeCustomerId);
  if (!pmId) {
    return {
      success: false,
      status: "no_payment_method",
      reason:
        "No card on file. Use Manage billing to add a payment method, then try Reactivate again.",
      charged: false,
    };
  }

  // Ensure default PM is set on customer for invoices
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

  const subPrice =
    created.items.data[0]?.price?.id?.startsWith("price_")
      ? created.items.data[0].price.id
      : priceId;
  const commerceId = getConfiguredMemberstackPlanId() || subPrice;

  await applyTrustedPaymentByMemberstackId({
    memberstackId: msId,
    stripeCustomerId,
    patch: {
      [MEMBER_FIELDS.stripeSubscriptionId]: created.id,
      [MEMBER_FIELDS.stripeSubscriptionStatus]: created.status,
      [MEMBER_FIELDS.stripePriceId]: commerceId,
      [MEMBER_FIELDS.memberstackPlanId]: getConfiguredMemberstackPlanId() || commerceId,
      ["Paid Plans (price ids)"]: formatPaidPlansText([commerceId, subPrice]),
      [MEMBER_FIELDS.cancelAtPeriodEnd]: false,
    },
  });

  return {
    success: true,
    status: "reactivated",
    reason: "Membership reactivated using your card on file",
    subscriptionId: created.id,
    subscriptionStatus: created.status,
    paymentMethodReused: true,
    charged: true,
  };
}
