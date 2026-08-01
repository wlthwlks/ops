import Stripe from "stripe";

let _stripe: Stripe | undefined;

/**
 * Server-only Stripe client. Lazy so Next.js build can import modules
 * without requiring STRIPE_SECRET_KEY at module evaluation time.
 */
export function getStripeClient(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  _stripe = new Stripe(key, {
    apiVersion: "2026-06-24.dahlia",
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 30_000,
  });
  return _stripe;
}

/**
 * Parse STRIPE_MEMBERSHIP_PRICE_IDS into a normalized Set.
 * Supports both Stripe Dashboard ids (`price_…`) and Memberstack commerce ids (`prc_…` / `pln_…`).
 * WLTH test membership: prc_wlth-wlks-45-quarter-pdpa0cyx
 */
export function getConfiguredMembershipPriceIds(options?: {
  requireConfigured?: boolean;
}): Set<string> {
  const raw = process.env.STRIPE_MEMBERSHIP_PRICE_IDS || "";
  const ids = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  // Also include dedicated Memberstack plan env so one source of truth is enough
  const ms = getConfiguredMemberstackPlanId();
  if (ms) ids.add(ms);
  if (options?.requireConfigured && ids.size === 0) {
    throw new Error(
      "STRIPE_MEMBERSHIP_PRICE_IDS / MEMBERSTACK_MEMBERSHIP_PRICE_ID missing. Configure membership price id(s)."
    );
  }
  return ids;
}

/**
 * Primary membership price/plan id to store on Airtable:
 * - "Stripe Price ID" and "Memberstack Plan ID" both use this when that is the commerce id.
 */
export function getConfiguredMemberstackPlanId(): string {
  return (
    (process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID || "").trim() ||
    (process.env.MEMBERSTACK_PLAN_ID || "").trim() ||
    (process.env.STRIPE_MEMBERSHIP_PRICE_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .find((id) => id.startsWith("prc_") || id.startsWith("pln_") || id.startsWith("price_")) ||
    ""
  );
}

/** Ids that can appear on Stripe Invoice line items (native Stripe price_ only). */
export function getStripeNativeMembershipPriceIds(): Set<string> {
  return new Set(
    [...getConfiguredMembershipPriceIds()].filter((id) => id.startsWith("price_"))
  );
}

/** True when config only has Memberstack-style ids (prc_/pln_) — invoice lines won't match by id. */
export function membershipConfigIsMemberstackStyleOnly(): boolean {
  const ids = [...getConfiguredMembershipPriceIds()];
  if (ids.length === 0) return false;
  return ids.every((id) => id.startsWith("prc_") || id.startsWith("pln_"));
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return secret;
}
