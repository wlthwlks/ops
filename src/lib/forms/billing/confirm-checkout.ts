/**
 * Trusted post-checkout confirmation.
 * Verifies payment with Stripe and/or Memberstack Admin API, then links
 * Stripe Customer ID onto the Airtable member matched by Memberstack ID.
 */
import type Stripe from "stripe";
import { getStripeClient, getConfiguredMembershipPriceIds } from "@/lib/integrations/stripe";
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

/** Pull cus_… from Memberstack Admin member payload shapes. */
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

export type ConfirmCheckoutResult = {
  paymentConfirmed: boolean;
  status: string;
  stripeCustomerId: string;
  reason: string;
  shadowed?: boolean;
};

/**
 * Confirm payment for an authenticated Memberstack member.
 */
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
    if (pay === "paid" && mem === "active" && cus.startsWith("cus_")) {
      return {
        paymentConfirmed: true,
        status: "already_paid",
        stripeCustomerId: cus,
        reason: "Airtable already shows Paid + Active with Stripe Customer ID",
      };
    }
  }

  const stripe = getStripeClient();
  let stripeCustomerId = "";
  let subscriptionId = "";
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
        if (p && typeof p === "object" && typeof p.id === "string") priceIds.push(p.id);
      }
      priceIds =
        membershipIds.size > 0
          ? dedupePriceIds(priceIds.filter((id) => membershipIds.has(id)))
          : dedupePriceIds(priceIds);
    }
  }

  // 2) Memberstack Admin stripe id
  if (!stripeCustomerId && input.memberstackRaw) {
    stripeCustomerId = extractStripeCustomerIdFromMemberstackRaw(input.memberstackRaw);
  }

  // 3) Authenticated email → customer with active membership sub (post-auth only)
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
      const active = subs.data.find(
        (s) => s.status === "active" || s.status === "trialing" || s.status === "past_due"
      );
      if (!active) continue;
      const subPrices = active.items.data
        .map((it) => it.price?.id)
        .filter((id): id is string => Boolean(id));
      if (membershipIds.size === 0 || subPrices.some((id) => membershipIds.has(id))) {
        stripeCustomerId = customer.id;
        subscriptionId = active.id;
        priceIds = dedupePriceIds(
          membershipIds.size > 0
            ? subPrices.filter((id) => membershipIds.has(id))
            : subPrices
        );
        verifiedPaid = true;
        break;
      }
    }
  }

  // 4) Verify via paid membership invoices
  if (stripeCustomerId && !verifiedPaid && membershipIds.size > 0) {
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

  // 5) Any active subscription on customer counts as paid if no price allowlist configured
  if (stripeCustomerId && !verifiedPaid) {
    const subs = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "active",
      limit: 5,
    });
    if (subs.data.length > 0) {
      verifiedPaid = true;
      subscriptionId = subs.data[0].id;
      priceIds = dedupePriceIds(
        subs.data[0].items.data
          .map((it) => it.price?.id)
          .filter((id): id is string => Boolean(id))
      );
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
        "Linked Stripe Customer ID; waiting for paid membership invoice. Retry in a moment.",
    };
  }

  const patch: Record<string, unknown> = {
    [MEMBER_FIELDS.onboardingStatus]: "PAYMENT_CONFIRMED",
    [MEMBER_FIELDS.stripeSubscriptionStatus]: subscriptionId ? "active" : "active",
  };
  if (subscriptionId) {
    patch[MEMBER_FIELDS.stripeSubscriptionId] = subscriptionId;
  }
  if (priceIds.length > 0) {
    patch[MEMBER_FIELDS.stripePriceId] = priceIds[0];
    patch["Paid Plans (price ids)"] = formatPaidPlansText(priceIds);
  } else {
    // Fall back to configured membership price id when line items unavailable
    const configured = [...membershipIds];
    if (configured[0]) {
      patch[MEMBER_FIELDS.stripePriceId] = configured[0];
      patch["Paid Plans (price ids)"] = formatPaidPlansText(configured);
    }
  }
  const msPlan =
    (process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID || "").trim() ||
    (process.env.MEMBERSTACK_PLAN_ID || "").trim();
  if (msPlan) {
    patch[MEMBER_FIELDS.memberstackPlanId] = msPlan;
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
        ? "Linked Stripe Customer ID and marked Paid/Active"
        : result.status === "shadowed"
          ? "Shadow mode — would mark Paid"
          : result.status,
    shadowed: result.shadowed,
  };
}
