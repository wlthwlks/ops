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
 * Throws if empty when requireConfigured is true.
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
  if (options?.requireConfigured && ids.size === 0) {
    throw new Error(
      "STRIPE_MEMBERSHIP_PRICE_IDS is missing or empty. Configure comma-separated membership Price IDs."
    );
  }
  return ids;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return secret;
}
