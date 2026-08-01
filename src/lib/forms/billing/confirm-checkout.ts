/**
 * Trusted post-checkout confirmation.
 * Verifies payment with Stripe, links cus_… by Memberstack ID, writes billing columns.
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
  linkStripeCustomerIdByMemberstackId,
} from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import {
  getQualifyingMembershipPriceIds,
  listAllInvoiceLines,
  paidThroughFromInvoiceLines,
  formatPaidPlansText,
  dedupePriceIds,
} from "@/lib/billing/service-access-sync";
import { FormsError } from "@/lib/forms/errors";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function extractStripeCustomerIdFromMemberstackRaw(
  raw: Record<string, unknown>
): string {
  const candidates: unknown[] = [
    raw.stripeCustomerId,
    raw.stripe_customer_id,
    isRecord(raw.stripe) ? raw.stripe.customerId : null,
    isRecord(raw.stripe) ? raw.stripe.customer_id : null,
    isRecord(raw.billing) ? raw.billing.stripeCustomerId : null,
    isRecord(raw.billing) ? raw.billing.customerId : null,
    isRecord(raw.data) ? (raw.data as Record<string, unknown>).stripeCustomerId : null,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().startsWith("cus_")) return c.trim();
  }
  return "";
}

function sessionCustomerId(session: Stripe.Checkout.Session): string {
  const c = session.customer;
  if (typeof c === "string" && c.startsWith("cus_")) return c;
  if (c && typeof c === "object" && "id" in c && typeof c.id === "string") {
    return c.id.startsWith("cus_") ? c.id : "";
  }
  return "";
}

function sessionSubscriptionId(session: Stripe.Checkout.Session): string {
  const s = session.subscription;
  if (typeof s === "string" && s.startsWith("sub_")) return s;
  if (s && typeof s === "object" && "id" in s && typeof s.id === "string") {
    return s.id.startsWith("sub_") ? s.id : "";
  }
  return "";
}

/** Load subscription prices + real Stripe status. */
async function loadSubscriptionBilling(
  stripe: Stripe,
  subscriptionId: string
): Promise<{
  status: string;
  priceIds: string[];
}> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const priceIds = dedupePriceIds(
    sub.items.data
      .map((it) => it.price?.id)
      .filter((id): id is string => Boolean(id) && id.startsWith("price_"))
  );
  return { status: sub.status, priceIds };
}

export type ConfirmCheckoutResult = {
  paymentConfirmed: boolean;
  status: string;
  stripeCustomerId: string;
  reason: string;
  shadowed?: boolean;
};

export async function confirmCheckoutForMember(input: {
  memberstackId: string;
  memberEmail: string;
  memberstackRaw?: Record<string, unknown>;
  checkoutSessionId?: string | null;
}): Promise<ConfirmCheckoutResult> {
  const msId = input.memberstackId.trim();
  if (!msId) {
    throw new FormsError("MEMBERSTACK_API_FAILED", "Missing Memberstack member id", {
      status: 401,
    });
  }

  const existingRows = await findMemberByMemberstackId(msId);
  if (existingRows.length === 1) {
    const f = existingRows[0].fields;
    const pay = String(f[MEMBER_FIELDS.payment] || "").toLowerCase();
    const mem = String(f[MEMBER_FIELDS.membership] || "").toLowerCase();
    const cus = String(f[MEMBER_FIELDS.stripeCustomerId] || "").trim();
    const hasPrice = String(f[MEMBER_FIELDS.stripePriceId] || "").startsWith("price_");
    const hasStatus = Boolean(String(f[MEMBER_FIELDS.stripeSubscriptionStatus] || "").trim());
    const hasMsPlan = Boolean(String(f[MEMBER_FIELDS.memberstackPlanId] || "").trim());
    // Already fully paid with billing columns — still refresh missing columns below if needed
    if (pay === "paid" && mem === "active" && cus.startsWith("cus_") && hasPrice && hasStatus && hasMsPlan) {
      return {
        paymentConfirmed: true,
        status: "already_paid",
        stripeCustomerId: cus,
        reason: "Airtable already shows Paid + Active with billing columns",
      };
    }
  }

  const stripe = getStripeClient();
  let stripeCustomerId = "";
  let subscriptionId = "";
  let subscriptionStatus = "";
  let priceIds: string[] = [];
  let paidThrough: Date | null = null;
  let verifiedPaid = false;
  const membershipIds = getConfiguredMembershipPriceIds({ requireConfigured: false });

  // 1) Checkout session
  const sessionId = (input.checkoutSessionId || "").trim();
  if (sessionId.startsWith("cs_")) {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price", "subscription"],
    });
    stripeCustomerId = sessionCustomerId(session);
    subscriptionId = sessionSubscriptionId(session);
    const paid =
      session.payment_status === "paid" ||
      session.status === "complete" ||
      session.payment_status === "no_payment_required";
    if (paid && stripeCustomerId) {
      verifiedPaid = true;
      for (const li of session.line_items?.data || []) {
        const p = li.price;
        if (p && typeof p === "object" && typeof p.id === "string" && p.id.startsWith("price_")) {
          priceIds.push(p.id);
        }
      }
      priceIds = dedupePriceIds(priceIds);
      if (membershipIds.size > 0) {
        const filtered = priceIds.filter((id) => membershipIds.has(id));
        if (filtered.length > 0) priceIds = filtered;
      }
    }
  }

  // 2) Memberstack Admin stripe id
  if (!stripeCustomerId && input.memberstackRaw) {
    stripeCustomerId = extractStripeCustomerIdFromMemberstackRaw(input.memberstackRaw);
  }

  // 3) Existing Airtable Stripe Customer ID
  if (!stripeCustomerId && existingRows.length === 1) {
    const existingCus = String(
      existingRows[0].fields[MEMBER_FIELDS.stripeCustomerId] || ""
    ).trim();
    if (existingCus.startsWith("cus_")) stripeCustomerId = existingCus;
  }

  // 4) Email → customer with subscription
  if (!stripeCustomerId && input.memberEmail) {
    const list = await stripe.customers.list({
      email: input.memberEmail.toLowerCase(),
      limit: 5,
    });
    for (const customer of list.data) {
      if (!customer.id.startsWith("cus_")) continue;
      const subs = await stripe.subscriptions.list({
        customer: customer.id,
        status: "all",
        limit: 10,
      });
      const pick = subs.data.find((s) =>
        ["active", "trialing", "past_due", "unpaid", "paused"].includes(s.status)
      ) || subs.data[0];
      if (!pick) continue;
      stripeCustomerId = customer.id;
      subscriptionId = pick.id;
      subscriptionStatus = pick.status;
      priceIds = dedupePriceIds(
        pick.items.data
          .map((it) => it.price?.id)
          .filter((id): id is string => Boolean(id) && id.startsWith("price_"))
      );
      verifiedPaid = ["active", "trialing", "past_due"].includes(pick.status);
      if (verifiedPaid) break;
    }
  }

  // 5) Paid invoices for customer
  if (stripeCustomerId && !verifiedPaid) {
    const invoices = await stripe.invoices.list({
      customer: stripeCustomerId,
      status: "paid",
      limit: 8,
    });
    for (const inv of invoices.data) {
      if (!inv.id) continue;
      const lines = await listAllInvoiceLines(stripe, inv.id);
      const through = paidThroughFromInvoiceLines(lines, membershipIds);
      if (through) {
        verifiedPaid = true;
        paidThrough = through;
        priceIds = getQualifyingMembershipPriceIds(lines, membershipIds);
        break;
      }
    }
  }

  // 6) Any subscription on customer
  if (stripeCustomerId && (!subscriptionId || !subscriptionStatus || priceIds.length === 0)) {
    const subs = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
    });
    const pick =
      subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status)) ||
      subs.data[0];
    if (pick) {
      subscriptionId = subscriptionId || pick.id;
      if (!subscriptionStatus) subscriptionStatus = pick.status;
      if (priceIds.length === 0) {
        priceIds = dedupePriceIds(
          pick.items.data
            .map((it) => it.price?.id)
            .filter((id): id is string => Boolean(id) && id.startsWith("price_"))
        );
      }
      if (["active", "trialing", "past_due"].includes(pick.status)) {
        verifiedPaid = true;
      }
    }
  }

  // Refresh subscription status/prices from Stripe when we have sub id
  if (subscriptionId) {
    try {
      const live = await loadSubscriptionBilling(stripe, subscriptionId);
      subscriptionStatus = live.status;
      if (live.priceIds.length > 0) {
        priceIds = dedupePriceIds([...priceIds, ...live.priceIds]);
      }
      if (["active", "trialing", "past_due"].includes(live.status)) {
        verifiedPaid = true;
      }
    } catch {
      /* keep prior */
    }
  }

  if (!stripeCustomerId) {
    return {
      paymentConfirmed: false,
      status: "stripe_customer_unresolved",
      stripeCustomerId: "",
      reason:
        "Could not resolve Stripe Customer ID. Ensure checkout completed and Memberstack is linked to Stripe.",
    };
  }

  if (!verifiedPaid) {
    await linkStripeCustomerIdByMemberstackId({
      memberstackId: msId,
      stripeCustomerId,
    }).catch(() => undefined);
    return {
      paymentConfirmed: false,
      status: "customer_linked_payment_pending",
      stripeCustomerId,
      reason:
        "Linked Stripe Customer ID; waiting for paid membership. Retry in a moment.",
    };
  }

  // Canonical membership price for this product (prc_wlth-wlks-… or price_…)
  const configuredPlan = getConfiguredMemberstackPlanId();
  const allPriceIds = dedupePriceIds([
    ...priceIds,
    ...(configuredPlan ? [configuredPlan] : []),
    ...[...membershipIds],
  ]);
  // Prefer Memberstack commerce id (prc_…) for Airtable Stripe Price ID when configured
  const primaryPriceId =
    allPriceIds.find((id) => id.startsWith("prc_") || id.startsWith("pln_")) ||
    configuredPlan ||
    allPriceIds.find((id) => id.startsWith("price_")) ||
    allPriceIds[0] ||
    "";

  const patch: Record<string, unknown> = {
    [MEMBER_FIELDS.onboardingStatus]: "PAYMENT_CONFIRMED",
  };
  if (subscriptionId) {
    patch[MEMBER_FIELDS.stripeSubscriptionId] = subscriptionId;
  }
  // Always write status from Stripe when known
  patch[MEMBER_FIELDS.stripeSubscriptionStatus] = subscriptionStatus || "active";

  if (primaryPriceId) {
    patch[MEMBER_FIELDS.stripePriceId] = primaryPriceId;
    patch["Paid Plans (price ids)"] = formatPaidPlansText(
      dedupePriceIds([primaryPriceId, ...allPriceIds])
    );
  }
  // Same id on Memberstack Plan ID
  if (configuredPlan || primaryPriceId) {
    patch[MEMBER_FIELDS.memberstackPlanId] = configuredPlan || primaryPriceId;
  }
  if (paidThrough) {
    patch[MEMBER_FIELDS.serviceAccessUntil] = paidThrough.toISOString().slice(0, 10);
  }

  const result = await applyTrustedPaymentByMemberstackId({
    memberstackId: msId,
    stripeCustomerId,
    patch,
  });

  return {
    paymentConfirmed: result.status === "updated" || result.status === "shadowed",
    status: result.status,
    stripeCustomerId,
    reason:
      result.status === "updated"
        ? `Paid/Active + Stripe Price ID=${primaryPriceId || "—"} Status=${subscriptionStatus || "active"} Memberstack Plan ID=${configuredPlan || primaryPriceId || "—"}`
        : result.status === "shadowed"
          ? "Shadow mode — would mark Paid"
          : result.status,
    shadowed: result.shadowed,
  };
}
