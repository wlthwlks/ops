/**
 * Trusted post-checkout confirmation.
 * Verifies payment with Stripe, proves session ownership, requires native membership price.
 */
import type Stripe from "stripe";
import {
  getStripeClient,
  getConfiguredMemberstackPlanId,
  getStripeNativeMembershipPriceIds,
  hasNativeStripeMembershipPrices,
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
  resolveNativeMembershipAllowlist,
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

export function sessionCustomerId(session: Stripe.Checkout.Session): string {
  const c = session.customer;
  if (typeof c === "string" && c.startsWith("cus_")) return c;
  if (c && typeof c === "object" && "id" in c && typeof c.id === "string") {
    return c.id.startsWith("cus_") ? c.id : "";
  }
  return "";
}

export function sessionSubscriptionId(session: Stripe.Checkout.Session): string {
  const s = session.subscription;
  if (typeof s === "string" && s.startsWith("sub_")) return s;
  if (s && typeof s === "object" && "id" in s && typeof s.id === "string") {
    return s.id.startsWith("sub_") ? s.id : "";
  }
  return "";
}

export function extractSessionLinePriceIds(session: Stripe.Checkout.Session): string[] {
  const ids: string[] = [];
  for (const li of session.line_items?.data || []) {
    const p = li.price;
    if (p && typeof p === "object" && typeof p.id === "string" && p.id.startsWith("price_")) {
      ids.push(p.id);
    }
  }
  return dedupePriceIds(ids);
}

/**
 * Prove the Checkout Session belongs to this Memberstack member.
 * Order: client_reference_id → metadata.memberstackId → Airtable cus_ → Memberstack Admin cus_.
 */
export function verifyCheckoutSessionOwnership(input: {
  memberstackId: string;
  session: Stripe.Checkout.Session;
  existingAirtableStripeCustomerId?: string;
  memberstackAdminStripeCustomerId?: string;
}): { ok: true; method: string } | { ok: false; reason: string; status: string } {
  const msId = input.memberstackId.trim();
  const session = input.session;
  const sessionCus = sessionCustomerId(session);

  const ref = (session.client_reference_id || "").trim();
  if (ref) {
    if (ref === msId) return { ok: true, method: "client_reference_id" };
    return {
      ok: false,
      status: "session_ownership_mismatch",
      reason: "Checkout Session client_reference_id does not match authenticated member",
    };
  }

  const metaMs =
    (session.metadata?.memberstackId || session.metadata?.memberstack_id || "").trim();
  if (metaMs) {
    if (metaMs === msId) return { ok: true, method: "metadata.memberstackId" };
    return {
      ok: false,
      status: "session_ownership_mismatch",
      reason: "Checkout Session metadata memberstackId does not match authenticated member",
    };
  }

  const airtableCus = (input.existingAirtableStripeCustomerId || "").trim();
  if (airtableCus.startsWith("cus_") && sessionCus) {
    if (airtableCus === sessionCus) return { ok: true, method: "airtable_stripe_customer_id" };
    return {
      ok: false,
      status: "stripe_customer_conflict",
      reason: "Checkout Session customer conflicts with Stripe Customer ID already on this member",
    };
  }

  const adminCus = (input.memberstackAdminStripeCustomerId || "").trim();
  if (adminCus.startsWith("cus_") && sessionCus) {
    if (adminCus === sessionCus) return { ok: true, method: "memberstack_admin_customer" };
    return {
      ok: false,
      status: "session_ownership_mismatch",
      reason: "Checkout Session customer does not match Memberstack-linked Stripe customer",
    };
  }

  return {
    ok: false,
    status: "session_ownership_unproven",
    reason:
      "Cannot prove Checkout Session belongs to this member (missing client_reference_id, metadata, or matching Stripe Customer ID)",
  };
}

/** Session must be paid; complete-but-unpaid does not qualify. */
export function isCheckoutSessionPaid(session: Stripe.Checkout.Session): boolean {
  return (
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required"
  );
}

export function filterNativeQualifyingPrices(
  priceIds: string[],
  nativeAllow: Set<string>
): string[] {
  if (nativeAllow.size === 0) return [];
  return dedupePriceIds(priceIds.filter((id) => nativeAllow.has(id)));
}

async function loadSubscriptionBilling(
  stripe: Stripe,
  subscriptionId: string
): Promise<{ status: string; priceIds: string[] }> {
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
    if (
      pay === "paid" &&
      mem === "active" &&
      cus.startsWith("cus_") &&
      hasPrice &&
      hasStatus &&
      hasMsPlan
    ) {
      return {
        paymentConfirmed: true,
        status: "already_paid",
        stripeCustomerId: cus,
        reason: "Airtable already shows Paid + Active with billing columns",
      };
    }
  }

  const existingAirtableCus =
    existingRows.length === 1
      ? String(existingRows[0].fields[MEMBER_FIELDS.stripeCustomerId] || "").trim()
      : "";
  const memberstackAdminCus = input.memberstackRaw
    ? extractStripeCustomerIdFromMemberstackRaw(input.memberstackRaw)
    : "";

  const nativeAllow = resolveNativeMembershipAllowlist();
  if (
    (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") &&
    nativeAllow.size === 0
  ) {
    return {
      paymentConfirmed: false,
      status: "membership_price_config_missing",
      stripeCustomerId: "",
      reason:
        "No native Stripe membership Price IDs (price_…) configured. Set STRIPE_MEMBERSHIP_PRICE_IDS.",
    };
  }

  const stripe = getStripeClient();
  let stripeCustomerId = "";
  let subscriptionId = "";
  let subscriptionStatus = "";
  let priceIds: string[] = [];
  let paidThrough: Date | null = null;
  let verifiedPaid = false;
  let usedCheckoutSession = false;

  // 1) Checkout session path — strict ownership + paid + price
  const sessionId = (input.checkoutSessionId || "").trim();
  if (sessionId.startsWith("cs_")) {
    usedCheckoutSession = true;
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price", "subscription"],
    });

    if (!isCheckoutSessionPaid(session)) {
      return {
        paymentConfirmed: false,
        status: "session_not_paid",
        stripeCustomerId: sessionCustomerId(session),
        reason: `Checkout Session payment_status is ${session.payment_status || "unknown"}, not paid`,
      };
    }

    const ownership = verifyCheckoutSessionOwnership({
      memberstackId: msId,
      session,
      existingAirtableStripeCustomerId: existingAirtableCus,
      memberstackAdminStripeCustomerId: memberstackAdminCus,
    });
    if (!ownership.ok) {
      return {
        paymentConfirmed: false,
        status: ownership.status,
        stripeCustomerId: "",
        reason: ownership.reason,
      };
    }

    stripeCustomerId = sessionCustomerId(session);
    subscriptionId = sessionSubscriptionId(session);
    priceIds = filterNativeQualifyingPrices(extractSessionLinePriceIds(session), nativeAllow);

    if (priceIds.length === 0 && subscriptionId) {
      try {
        const live = await loadSubscriptionBilling(stripe, subscriptionId);
        priceIds = filterNativeQualifyingPrices(live.priceIds, nativeAllow);
        subscriptionStatus = live.status;
      } catch {
        /* keep */
      }
    }

    if (priceIds.length === 0) {
      return {
        paymentConfirmed: false,
        status: "session_price_not_membership",
        stripeCustomerId: "",
        reason: "Checkout Session has no approved WLTH membership Stripe Price ID",
      };
    }

    if (
      existingAirtableCus.startsWith("cus_") &&
      stripeCustomerId &&
      existingAirtableCus !== stripeCustomerId
    ) {
      return {
        paymentConfirmed: false,
        status: "stripe_customer_conflict",
        stripeCustomerId: "",
        reason: "Session Stripe Customer ID conflicts with the member’s stored customer",
      };
    }

    verifiedPaid = true;
  }

  // 2–4) No session id: recover via Memberstack Admin / Airtable / guarded email
  if (!usedCheckoutSession) {
    if (!stripeCustomerId && memberstackAdminCus.startsWith("cus_")) {
      stripeCustomerId = memberstackAdminCus;
    }
    if (!stripeCustomerId && existingAirtableCus.startsWith("cus_")) {
      stripeCustomerId = existingAirtableCus;
    }

    // Email fallback only when no stronger id — exactly one Stripe customer
    if (!stripeCustomerId && input.memberEmail) {
      const list = await stripe.customers.list({
        email: input.memberEmail.toLowerCase(),
        limit: 10,
      });
      const customers = list.data.filter((c) => c.id.startsWith("cus_"));
      if (customers.length > 1) {
        return {
          paymentConfirmed: false,
          status: "stripe_customer_ambiguous",
          stripeCustomerId: "",
          reason:
            "Multiple Stripe customers share this email. Link an exact Stripe Customer ID before confirming.",
        };
      }
      if (customers.length === 1) {
        stripeCustomerId = customers[0].id;
      }
    }

    if (stripeCustomerId) {
      const invoices = await stripe.invoices.list({
        customer: stripeCustomerId,
        status: "paid",
        limit: 8,
      });
      for (const inv of invoices.data) {
        if (!inv.id) continue;
        const lines = await listAllInvoiceLines(stripe, inv.id);
        const through = paidThroughFromInvoiceLines(lines, nativeAllow);
        if (through) {
          verifiedPaid = true;
          paidThrough = through;
          priceIds = getQualifyingMembershipPriceIds(lines, nativeAllow);
          break;
        }
      }
    }

    if (stripeCustomerId && (!subscriptionId || priceIds.length === 0 || !verifiedPaid)) {
      const subs = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: "all",
        limit: 10,
      });
      const pick =
        subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status)) ||
        null;
      if (pick) {
        subscriptionId = subscriptionId || pick.id;
        subscriptionStatus = pick.status;
        const subPrices = filterNativeQualifyingPrices(
          pick.items.data
            .map((it) => it.price?.id)
            .filter((id): id is string => Boolean(id) && id.startsWith("price_")),
          nativeAllow
        );
        if (subPrices.length > 0) {
          priceIds = dedupePriceIds([...priceIds, ...subPrices]);
          if (["active", "trialing", "past_due"].includes(pick.status)) {
            verifiedPaid = true;
          }
        }
      }
    }
  }

  if (subscriptionId) {
    try {
      const live = await loadSubscriptionBilling(stripe, subscriptionId);
      subscriptionStatus = live.status;
      const liveQualifying = filterNativeQualifyingPrices(live.priceIds, nativeAllow);
      if (liveQualifying.length > 0) {
        priceIds = dedupePriceIds([...priceIds, ...liveQualifying]);
      }
      if (["active", "trialing", "past_due"].includes(live.status) && priceIds.length > 0) {
        verifiedPaid = true;
      }
    } catch {
      /* keep prior */
    }
  }

  // Final price gate for all paths
  priceIds = filterNativeQualifyingPrices(priceIds, nativeAllow);
  if (verifiedPaid && priceIds.length === 0) {
    return {
      paymentConfirmed: false,
      status: "session_price_not_membership",
      stripeCustomerId: "",
      reason: "No approved native Stripe membership Price ID on payment",
    };
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
    // Only link customer when ownership was already established without marking Paid
    if (!usedCheckoutSession) {
      await linkStripeCustomerIdByMemberstackId({
        memberstackId: msId,
        stripeCustomerId,
      }).catch(() => undefined);
    }
    return {
      paymentConfirmed: false,
      status: "customer_linked_payment_pending",
      stripeCustomerId,
      reason: "Linked Stripe Customer ID; waiting for paid membership. Retry in a moment.",
    };
  }

  const configuredPlan = getConfiguredMemberstackPlanId();
  const primaryPriceId =
    priceIds[0] ||
    (configuredPlan.startsWith("price_") ? configuredPlan : "") ||
    configuredPlan ||
    "";

  const patch: Record<string, unknown> = {
    [MEMBER_FIELDS.onboardingStatus]: "PAYMENT_CONFIRMED",
  };
  if (subscriptionId) {
    patch[MEMBER_FIELDS.stripeSubscriptionId] = subscriptionId;
  }
  patch[MEMBER_FIELDS.stripeSubscriptionStatus] = subscriptionStatus || "active";

  if (primaryPriceId) {
    patch[MEMBER_FIELDS.stripePriceId] = primaryPriceId;
    patch["Paid Plans (price ids)"] = formatPaidPlansText(
      dedupePriceIds([primaryPriceId, ...priceIds])
    );
  }
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

// silence unused import if tree-shaken differently
void hasNativeStripeMembershipPrices;
void getStripeNativeMembershipPriceIds;
