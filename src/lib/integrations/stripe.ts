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

export type MembershipPriceConfig = {
  /** Native Stripe Price IDs (price_…) — only these qualify invoices/sessions. */
  nativeStripePriceIds: string[];
  /** Memberstack commerce IDs (prc_… / pln_…) — Airtable display only. */
  memberstackCommerceIds: string[];
  /** All configured ids (native + commerce), deduped. */
  allIds: string[];
};

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Parse membership price configuration from env.
 * Native Stripe `price_…` ids qualify Stripe invoices/checkout.
 * Memberstack `prc_…` / `pln_…` ids are stored on Airtable only.
 */
export function parseMembershipPriceConfig(options?: {
  stripeMembershipPriceIds?: string;
  memberstackMembershipPriceId?: string;
  memberstackPlanId?: string;
}): MembershipPriceConfig {
  const stripeRaw =
    options?.stripeMembershipPriceIds ?? process.env.STRIPE_MEMBERSHIP_PRICE_IDS ?? "";
  const msPrimary =
    options?.memberstackMembershipPriceId ??
    process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID ??
    "";
  const msPlan = options?.memberstackPlanId ?? process.env.MEMBERSTACK_PLAN_ID ?? "";

  const fromStripeEnv = splitCsv(stripeRaw);
  const extras = [msPrimary.trim(), msPlan.trim()].filter(Boolean);
  const all = dedupePreserveOrder([...fromStripeEnv, ...extras]);

  const nativeStripePriceIds = all.filter((id) => id.startsWith("price_"));
  const memberstackCommerceIds = all.filter(
    (id) => id.startsWith("prc_") || id.startsWith("pln_")
  );

  return {
    nativeStripePriceIds: dedupePreserveOrder(nativeStripePriceIds),
    memberstackCommerceIds: dedupePreserveOrder(memberstackCommerceIds),
    allIds: all,
  };
}

/**
 * @deprecated Prefer parseMembershipPriceConfig + getStripeNativeMembershipPriceIds.
 * Returns all configured ids (native + Memberstack) for backward-compatible call sites
 * that store commerce ids on Airtable.
 */
export function getConfiguredMembershipPriceIds(options?: {
  requireConfigured?: boolean;
}): Set<string> {
  const cfg = parseMembershipPriceConfig();
  if (options?.requireConfigured && cfg.allIds.length === 0) {
    throw new Error(
      "STRIPE_MEMBERSHIP_PRICE_IDS / MEMBERSTACK_MEMBERSHIP_PRICE_ID missing. Configure membership price id(s)."
    );
  }
  return new Set(cfg.allIds);
}

/**
 * Primary membership price/plan id to store on Airtable Memberstack Plan ID / display.
 * Prefers Memberstack commerce id when configured.
 */
export function getConfiguredMemberstackPlanId(): string {
  const cfg = parseMembershipPriceConfig();
  return (
    cfg.memberstackCommerceIds[0] ||
    cfg.nativeStripePriceIds[0] ||
    cfg.allIds[0] ||
    ""
  );
}

/** Native Stripe Price ids only — used to qualify invoices and Checkout Sessions. */
export function getStripeNativeMembershipPriceIds(options?: {
  requireConfigured?: boolean;
  /** When true (default in production), throw if no native price_ ids. */
  failClosedInProduction?: boolean;
}): Set<string> {
  const cfg = parseMembershipPriceConfig();
  const set = new Set(cfg.nativeStripePriceIds);

  // Prefer VERCEL_ENV — preview deployments still set NODE_ENV=production
  const vercelEnv = (process.env.VERCEL_ENV || "").trim();
  const isProdBilling = vercelEnv
    ? vercelEnv === "production"
    : process.env.NODE_ENV === "production";
  const failClosed =
    options?.failClosedInProduction !== false && isProdBilling;

  if (options?.requireConfigured || failClosed) {
    if (set.size === 0) {
      throw new Error(
        "No native Stripe membership Price IDs (price_…) configured. Set STRIPE_MEMBERSHIP_PRICE_IDS=price_…"
      );
    }
  }
  return set;
}

/**
 * True when config has only Memberstack-style ids (no native price_).
 * Used for diagnostics — must NOT enable allow-all invoice matching.
 */
export function membershipConfigIsMemberstackStyleOnly(): boolean {
  const cfg = parseMembershipPriceConfig();
  if (cfg.allIds.length === 0) return false;
  return cfg.nativeStripePriceIds.length === 0 && cfg.memberstackCommerceIds.length > 0;
}

/** True when at least one native Stripe price_ is configured. */
export function hasNativeStripeMembershipPrices(): boolean {
  return parseMembershipPriceConfig().nativeStripePriceIds.length > 0;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return secret;
}
