/**
 * Trusted post-checkout confirmation.
 *
 * Production: require native Stripe price_… allowlist + proven ownership.
 * Preview (Memberstack prc_-only config): owned customer + proven paid membership
 *   (active subscription or paid checkout) — never trust arbitrary session IDs alone.
 */
import type Stripe from "stripe";
import {
  getStripeClient,
  getConfiguredMemberstackPlanId,
  parseMembershipPriceConfig,
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
import { isInProgressOnboarding } from "@/lib/forms/onboarding/onboarding-status";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recent-payment window used to distinguish a NEW payment from historical
 * billing evidence. The recovery path (no checkout session id) must only mark a
 * member "paid" from evidence produced in the last few minutes — otherwise a
 * previously-cancelled member with an old paid invoice / stale active
 * subscription would be incorrectly revived and have "Service access until"
 * extended.
 */
const RECENT_PAYMENT_WINDOW_SEC = 2 * 60 * 60; // 2 hours

export function isRecentStripeTimestamp(
  unixSeconds: number | null | undefined,
  nowUnix: number = Math.floor(Date.now() / 1000)
): boolean {
  if (typeof unixSeconds !== "number" || unixSeconds <= 0) return false;
  return nowUnix - unixSeconds <= RECENT_PAYMENT_WINDOW_SEC;
}

function invoicePaidAtUnix(inv: Stripe.Invoice): number | null {
  const t = inv.status_transitions;
  if (t && typeof t.paid_at === "number") return t.paid_at;
  return null;
}

/**
 * Prefer VERCEL_ENV when set (preview builds still have NODE_ENV=production).
 * Local: fall back to NODE_ENV.
 */
export function isProductionBillingEnv(): boolean {
  const vercel = (process.env.VERCEL_ENV || "").trim();
  if (vercel) return vercel === "production";
  return process.env.NODE_ENV === "production";
}

/** Preview / dev may run with only Memberstack prc_… configured. */
export function allowsMemberstackCommercePreviewQualification(): boolean {
  if (isProductionBillingEnv()) return false;
  const cfg = parseMembershipPriceConfig();
  return (
    cfg.nativeStripePriceIds.length === 0 && cfg.memberstackCommerceIds.length > 0
  );
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
    isRecord(raw.data) && isRecord((raw.data as Record<string, unknown>).stripe)
      ? ((raw.data as Record<string, unknown>).stripe as Record<string, unknown>)
          .customerId
      : null,
  ];

  // Nested plan connections (Memberstack shapes vary)
  const dig = (obj: unknown, depth = 0): string => {
    if (depth > 4 || obj == null) return "";
    if (typeof obj === "string" && obj.trim().startsWith("cus_")) return obj.trim();
    if (!isRecord(obj)) return "";
    for (const [k, v] of Object.entries(obj)) {
      if (/stripe.*customer|customer.*id/i.test(k) && typeof v === "string") {
        const t = v.trim();
        if (t.startsWith("cus_")) return t;
      }
      if (isRecord(v) || Array.isArray(v)) {
        const found = dig(v, depth + 1);
        if (found) return found;
      }
      if (Array.isArray(v)) {
        for (const item of v) {
          const found = dig(item, depth + 1);
          if (found) return found;
        }
      }
    }
    return "";
  };

  for (const c of candidates) {
    if (typeof c === "string" && c.trim().startsWith("cus_")) return c.trim();
  }
  return dig(raw);
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

export type OwnershipResult =
  | { ok: true; method: string }
  | { ok: false; hard: boolean; reason: string; status: string };

/**
 * Prove the Checkout Session belongs to this Memberstack member.
 * hard=true → reject (wrong member / customer conflict).
 * hard=false → soft unproven; caller may fall through to recovery.
 */
export function verifyCheckoutSessionOwnership(input: {
  memberstackId: string;
  session: Stripe.Checkout.Session;
  existingAirtableStripeCustomerId?: string;
  memberstackAdminStripeCustomerId?: string;
}): OwnershipResult {
  const msId = input.memberstackId.trim();
  const session = input.session;
  const sessionCus = sessionCustomerId(session);

  const ref = (session.client_reference_id || "").trim();
  if (ref) {
    if (ref === msId) return { ok: true, method: "client_reference_id" };
    return {
      ok: false,
      hard: true,
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
      hard: true,
      status: "session_ownership_mismatch",
      reason: "Checkout Session metadata memberstackId does not match authenticated member",
    };
  }

  const airtableCus = (input.existingAirtableStripeCustomerId || "").trim();
  if (airtableCus.startsWith("cus_") && sessionCus) {
    if (airtableCus === sessionCus) return { ok: true, method: "airtable_stripe_customer_id" };
    return {
      ok: false,
      hard: true,
      status: "stripe_customer_conflict",
      reason: "Checkout Session customer conflicts with Stripe Customer ID already on this member",
    };
  }

  const adminCus = (input.memberstackAdminStripeCustomerId || "").trim();
  if (adminCus.startsWith("cus_") && sessionCus) {
    if (adminCus === sessionCus) return { ok: true, method: "memberstack_admin_customer" };
    return {
      ok: false,
      hard: true,
      status: "session_ownership_mismatch",
      reason: "Checkout Session customer does not match Memberstack-linked Stripe customer",
    };
  }

  return {
    ok: false,
    hard: false,
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

/**
 * Price gate:
 * - native allowlist non-empty → must match
 * - preview Memberstack-only → any price_ on a proven-paid object is enough
 * - production with empty native → fail
 */
export function passesPriceGate(input: {
  priceIds: string[];
  nativeAllow: Set<string>;
  previewCommerceMode: boolean;
}): { ok: boolean; qualifying: string[]; mode: string; reason?: string } {
  const prices = dedupePriceIds(input.priceIds.filter((id) => id.startsWith("price_")));

  if (input.nativeAllow.size > 0) {
    const qualifying = filterNativeQualifyingPrices(prices, input.nativeAllow);
    if (qualifying.length === 0) {
      return {
        ok: false,
        qualifying: [],
        mode: "native_allowlist",
        reason: "No approved native Stripe membership Price ID on payment",
      };
    }
    return { ok: true, qualifying, mode: "native_allowlist" };
  }

  if (input.previewCommerceMode) {
    if (prices.length === 0) {
      return {
        ok: false,
        qualifying: [],
        mode: "memberstack_commerce_preview",
        reason: "Paid membership has no Stripe price_ line items",
      };
    }
    return {
      ok: true,
      qualifying: prices,
      mode: "memberstack_commerce_preview",
    };
  }

  return {
    ok: false,
    qualifying: [],
    mode: "fail_closed",
    reason:
      "No native Stripe membership Price IDs (price_…) configured. Set STRIPE_MEMBERSHIP_PRICE_IDS.",
  };
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

async function listSessionPriceIds(
  stripe: Stripe,
  sessionId: string,
  session: Stripe.Checkout.Session
): Promise<string[]> {
  let ids = extractSessionLinePriceIds(session);
  if (ids.length > 0) return ids;
  try {
    const lines = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 20,
      expand: ["data.price"],
    });
    for (const li of lines.data) {
      const p = li.price;
      if (p && typeof p === "object" && typeof p.id === "string" && p.id.startsWith("price_")) {
        ids.push(p.id);
      }
    }
  } catch {
    /* keep empty */
  }
  return dedupePriceIds(ids);
}

/** Resolve exactly one Stripe customer for email, or ambiguity. */
async function resolveUniqueCustomerByEmail(
  stripe: Stripe,
  email: string
): Promise<
  | { ok: true; customerId: string }
  | { ok: false; status: "stripe_customer_ambiguous" | "none"; reason: string }
> {
  const list = await stripe.customers.list({
    email: email.toLowerCase(),
    limit: 10,
  });
  const customers = list.data.filter((c) => c.id.startsWith("cus_"));
  if (customers.length > 1) {
    return {
      ok: false,
      status: "stripe_customer_ambiguous",
      reason:
        "Multiple Stripe customers share this email. Link an exact Stripe Customer ID before confirming.",
    };
  }
  if (customers.length === 1) {
    return { ok: true, customerId: customers[0].id };
  }
  return { ok: false, status: "none", reason: "No Stripe customer for email" };
}

export type ConfirmCheckoutResult = {
  paymentConfirmed: boolean;
  status: string;
  stripeCustomerId: string;
  reason: string;
  shadowed?: boolean;
  qualificationMode?: string;
  ownershipMethod?: string;
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
    const hasPrice =
      String(f[MEMBER_FIELDS.stripePriceId] || "").startsWith("price_") ||
      String(f[MEMBER_FIELDS.stripePriceId] || "").startsWith("prc_");
    const hasStatus = Boolean(String(f[MEMBER_FIELDS.stripeSubscriptionStatus] || "").trim());
    const hasMsPlan = Boolean(String(f[MEMBER_FIELDS.memberstackPlanId] || "").trim());
    if (
      pay === "paid" &&
      mem === "active" &&
      cus.startsWith("cus_") &&
      (hasPrice || hasMsPlan) &&
      hasStatus
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
  const previewCommerceMode = allowsMemberstackCommercePreviewQualification();

  if (isProductionBillingEnv() && nativeAllow.size === 0) {
    console.error(
      JSON.stringify({
        event: "confirm_checkout_config",
        status: "membership_price_config_missing",
        nativeAllowCount: 0,
      })
    );
    return {
      paymentConfirmed: false,
      status: "membership_price_config_missing",
      stripeCustomerId: "",
      reason:
        "No native Stripe membership Price IDs (price_…) configured. Set STRIPE_MEMBERSHIP_PRICE_IDS.",
      qualificationMode: "fail_closed",
    };
  }

  const stripe = getStripeClient();
  let stripeCustomerId = "";
  let subscriptionId = "";
  let subscriptionStatus = "";
  let priceIds: string[] = [];
  let paidThrough: Date | null = null;
  let verifiedPaid = false;
  let ownershipMethod = "";
  let qualificationMode = "";

  const sessionId = (input.checkoutSessionId || "").trim();

  // —— 1) Optional Checkout Session path ——
  if (sessionId.startsWith("cs_")) {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price", "subscription", "customer"],
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

    if (ownership.ok === false && ownership.hard) {
      console.error(
        JSON.stringify({
          event: "confirm_checkout_ownership",
          status: ownership.status,
          hard: true,
          hasSessionId: true,
        })
      );
      return {
        paymentConfirmed: false,
        status: ownership.status,
        stripeCustomerId: "",
        reason: ownership.reason,
      };
    }

    const sessionCus = sessionCustomerId(session);
    let sessionOwned = ownership.ok === true;

    // Soft unproven: prove via unique email customer matching session customer
    if (!sessionOwned && sessionCus && input.memberEmail) {
      const byEmail = await resolveUniqueCustomerByEmail(stripe, input.memberEmail);
      if (byEmail.ok && byEmail.customerId === sessionCus) {
        sessionOwned = true;
        ownershipMethod = "session_customer_unique_email";
      } else if (!byEmail.ok && byEmail.status === "stripe_customer_ambiguous") {
        return {
          paymentConfirmed: false,
          status: "stripe_customer_ambiguous",
          stripeCustomerId: "",
          reason: byEmail.reason,
        };
      }
    }

    // Soft unproven: MS admin or airtable already set above; if still unproven, fall through
    if (sessionOwned || ownership.ok) {
      ownershipMethod =
        ownershipMethod || (ownership.ok ? ownership.method : ownershipMethod);
      stripeCustomerId = sessionCus;
      subscriptionId = sessionSubscriptionId(session);
      priceIds = await listSessionPriceIds(stripe, sessionId, session);

      if (priceIds.length === 0 && subscriptionId) {
        try {
          const live = await loadSubscriptionBilling(stripe, subscriptionId);
          priceIds = live.priceIds;
          subscriptionStatus = live.status;
        } catch {
          /* keep */
        }
      }

      const gate = passesPriceGate({
        priceIds,
        nativeAllow,
        previewCommerceMode,
      });
      qualificationMode = gate.mode;

      if (!gate.ok) {
        // Fall through to owned-customer recovery (webhook may still catch invoice)
        console.error(
          JSON.stringify({
            event: "confirm_checkout_session_price_gate",
            status: "session_price_not_membership",
            qualificationMode: gate.mode,
            priceCount: priceIds.length,
            nativeAllowCount: nativeAllow.size,
          })
        );
      } else {
        priceIds = gate.qualifying;
        verifiedPaid = true;
      }
    } else {
      // Soft unproven — do not trust session customer alone; recover below
      console.error(
        JSON.stringify({
          event: "confirm_checkout_ownership",
          status: "session_ownership_unproven",
          hard: false,
          hasSessionId: true,
          fallingThrough: true,
        })
      );
    }
  }

  // —— 2) Owned-customer recovery (no session, or session soft-fail / price gate fail) ——
  if (!verifiedPaid) {
    if (!stripeCustomerId && memberstackAdminCus.startsWith("cus_")) {
      stripeCustomerId = memberstackAdminCus;
      ownershipMethod = ownershipMethod || "memberstack_admin_customer";
    }
    if (!stripeCustomerId && existingAirtableCus.startsWith("cus_")) {
      stripeCustomerId = existingAirtableCus;
      ownershipMethod = ownershipMethod || "airtable_stripe_customer_id";
    }

    if (!stripeCustomerId && input.memberEmail) {
      const byEmail = await resolveUniqueCustomerByEmail(stripe, input.memberEmail);
      if (!byEmail.ok && byEmail.status === "stripe_customer_ambiguous") {
        return {
          paymentConfirmed: false,
          status: "stripe_customer_ambiguous",
          stripeCustomerId: "",
          reason: byEmail.reason,
        };
      }
      if (byEmail.ok) {
        stripeCustomerId = byEmail.customerId;
        ownershipMethod = ownershipMethod || "unique_email_customer";
      }
    }

    if (stripeCustomerId) {
      // Paid invoices with qualifying prices
      const invoices = await stripe.invoices.list({
        customer: stripeCustomerId,
        status: "paid",
        limit: 8,
      });
      for (const inv of invoices.data) {
        if (!inv.id) continue;
        // Only treat a paid invoice as evidence of a NEW payment when it was paid
        // recently. Historical paid invoices must not revive an expired member.
        if (!isRecentStripeTimestamp(invoicePaidAtUnix(inv))) continue;
        const lines = await listAllInvoiceLines(stripe, inv.id);

        const rawPrices: string[] = [];
        for (const line of lines) {
          const pricing = line.pricing as
            | { price_details?: { price?: string | { id?: string } } }
            | undefined;
          const pd = pricing?.price_details?.price;
          if (typeof pd === "string" && pd.startsWith("price_")) rawPrices.push(pd);
          else if (pd && typeof pd === "object" && typeof pd.id === "string") {
            rawPrices.push(pd.id);
          }
          const legacy = line as unknown as { price?: { id?: string } };
          if (legacy.price?.id?.startsWith("price_")) rawPrices.push(legacy.price.id);
        }

        const gate = passesPriceGate({
          priceIds: rawPrices,
          nativeAllow,
          previewCommerceMode,
        });
        if (!gate.ok) continue;

        if (nativeAllow.size > 0) {
          const through = paidThroughFromInvoiceLines(lines, nativeAllow);
          const q = getQualifyingMembershipPriceIds(lines, nativeAllow);
          if (through && q.length > 0) {
            verifiedPaid = true;
            paidThrough = through;
            priceIds = q;
            qualificationMode = "native_allowlist";
            break;
          }
        } else if (previewCommerceMode) {
          let maxEnd: number | null = null;
          for (const line of lines) {
            const end = line.period?.end;
            if (typeof end === "number" && (maxEnd == null || end > maxEnd)) {
              maxEnd = end;
            }
          }
          if (maxEnd != null) paidThrough = new Date(maxEnd * 1000);
          verifiedPaid = true;
          priceIds = gate.qualifying;
          qualificationMode = gate.mode;
          break;
        }
      }

      // Active subscription
      if (!verifiedPaid || priceIds.length === 0) {
        const subs = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: "all",
          limit: 10,
        });
        const pick =
          subs.data.find(
            (s) =>
              ["active", "trialing", "past_due"].includes(s.status) &&
              isRecentStripeTimestamp(s.created)
          ) || null;
        if (pick) {
          subscriptionId = subscriptionId || pick.id;
          subscriptionStatus = pick.status;
          const subPrices = pick.items.data
            .map((it) => it.price?.id)
            .filter((id): id is string => Boolean(id) && id.startsWith("price_"));
          const gate = passesPriceGate({
            priceIds: subPrices,
            nativeAllow,
            previewCommerceMode,
          });
          if (gate.ok && ["active", "trialing", "past_due"].includes(pick.status)) {
            verifiedPaid = true;
            priceIds = dedupePriceIds([...priceIds, ...gate.qualifying]);
            qualificationMode = gate.mode;
          }
        }
      }
    }
  }

  if (subscriptionId) {
    try {
      const live = await loadSubscriptionBilling(stripe, subscriptionId);
      subscriptionStatus = live.status || subscriptionStatus;
      if (live.priceIds.length > 0) {
        const gate = passesPriceGate({
          priceIds: live.priceIds,
          nativeAllow,
          previewCommerceMode,
        });
        if (gate.ok) {
          priceIds = dedupePriceIds([...priceIds, ...gate.qualifying]);
          qualificationMode = qualificationMode || gate.mode;
          if (["active", "trialing", "past_due"].includes(live.status)) {
            verifiedPaid = true;
          }
        }
      }
    } catch {
      /* keep prior */
    }
  }

  // Final gate
  if (verifiedPaid) {
    const gate = passesPriceGate({
      priceIds,
      nativeAllow,
      previewCommerceMode,
    });
    qualificationMode = gate.mode;
    if (!gate.ok) {
      console.error(
        JSON.stringify({
          event: "confirm_checkout_final_gate",
          status: gate.mode === "fail_closed" ? "membership_price_config_missing" : "session_price_not_membership",
          qualificationMode: gate.mode,
          ownershipMethod: ownershipMethod || null,
          nativeAllowCount: nativeAllow.size,
          priceCount: priceIds.length,
        })
      );
      return {
        paymentConfirmed: false,
        status:
          gate.mode === "fail_closed"
            ? "membership_price_config_missing"
            : "session_price_not_membership",
        stripeCustomerId: "",
        reason: gate.reason || "Price gate failed",
        qualificationMode: gate.mode,
        ownershipMethod: ownershipMethod || undefined,
      };
    }
    priceIds = gate.qualifying;
  }

  if (!stripeCustomerId) {
    return {
      paymentConfirmed: false,
      status: "stripe_customer_unresolved",
      stripeCustomerId: "",
      reason:
        "Could not resolve Stripe Customer ID. Ensure checkout completed and Memberstack is linked to Stripe.",
      ownershipMethod: ownershipMethod || undefined,
      qualificationMode: qualificationMode || undefined,
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
      reason: "Linked Stripe Customer ID; waiting for paid membership. Retry in a moment.",
      ownershipMethod: ownershipMethod || undefined,
      qualificationMode: qualificationMode || undefined,
    };
  }

  const configuredPlan = getConfiguredMemberstackPlanId();
  const primaryPriceId =
    priceIds[0] ||
    (configuredPlan.startsWith("price_") ? configuredPlan : "") ||
    configuredPlan ||
    "";

  const currentOnboardingStatus = String(
    existingRows[0]?.fields[MEMBER_FIELDS.onboardingStatus] ?? ""
  ).trim();

  const patch: Record<string, unknown> = {};
  // Only advance onboarding for genuinely in-progress signups. Established
  // members (blank legacy or COMPLETE) must never be reset into the signup form.
  if (isInProgressOnboarding(currentOnboardingStatus)) {
    patch[MEMBER_FIELDS.onboardingStatus] = "PAYMENT_CONFIRMED";
  }
  if (subscriptionId) {
    patch[MEMBER_FIELDS.stripeSubscriptionId] = subscriptionId;
  }
  patch[MEMBER_FIELDS.stripeSubscriptionStatus] = subscriptionStatus || "active";

  if (primaryPriceId) {
    patch[MEMBER_FIELDS.stripePriceId] = primaryPriceId;
    const paidPlans = dedupePriceIds([
      ...priceIds,
      ...(primaryPriceId.startsWith("price_") ? [primaryPriceId] : []),
    ]);
    if (paidPlans.length > 0) {
      patch["Paid Plans (price ids)"] = formatPaidPlansText(paidPlans);
    } else if (configuredPlan) {
      // Text field may store commerce id as plain text when no price_ yet
      patch["Paid Plans (price ids)"] = configuredPlan;
    }
  }
  if (configuredPlan || primaryPriceId) {
    patch[MEMBER_FIELDS.memberstackPlanId] = configuredPlan || primaryPriceId;
  }
  if (paidThrough) {
    patch[MEMBER_FIELDS.serviceAccessUntil] = paidThrough.toISOString().slice(0, 10);
  }

  console.error(
    JSON.stringify({
      event: "confirm_checkout_success_path",
      ownershipMethod: ownershipMethod || null,
      qualificationMode: qualificationMode || null,
      hasSubscription: Boolean(subscriptionId),
      qualifyingPriceCount: priceIds.length,
      nativeAllowCount: nativeAllow.size,
    })
  );

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
    qualificationMode: qualificationMode || undefined,
    ownershipMethod: ownershipMethod || undefined,
  };
}
