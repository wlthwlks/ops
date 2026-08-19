/**
 * Centralized, typed Billing Catalog / Offer Resolver.
 * Single source of truth for all membership prices and promo offers.
 *
 * Configuration precedence:
 *   1. BILLING_CATALOG_JSON (validated JSON, per-environment)
 *   2. Legacy env migration (MEMBERSTACK_MEMBERSHIP_PRICE_ID,
 *      MEMBERSTACK_PLAN_ID, STRIPE_MEMBERSHIP_PRICE_IDS,
 *      STRIPE_REACTIVATION_PRICE_ID) so existing deployments keep working.
 */

export type BillingCadence = "monthly" | "quarterly" | "yearly" | "custom";

export type CatalogPrice = {
  /** Stable internal key shared across Test/Preview/Production. */
  priceKey: string;
  /** Tier this price belongs to (standard | basic | gold | platinum | …). */
  tierKey: string;
  cadence: BillingCadence;
  /** Number of billing intervals (e.g. 3 for quarterly). */
  intervalCount?: number;
  /** Memberstack commerce id (prc_…). */
  memberstackPriceId?: string;
  /** Native Stripe Price id (price_…). */
  stripePriceId?: string;
  /** Whether this price can currently be sold to new purchasers. */
  sellable: boolean;
  /** Legacy / grandfathered price retained for existing members only. */
  legacy: boolean;
  eligibleForSignup: boolean;
  eligibleForReactivation: boolean;
  /** Customer-facing label, e.g. "$87 every 3 months". */
  label?: string;
  /** Customer-facing description, e.g. "3 months free, then $45 every 3 months". */
  description?: string;
  /** Trial length in days when configured externally in Stripe/Memberstack. */
  trialDays?: number;
  /** Display-only reference amount in USD. */
  amountUsd?: number;
};

export type CatalogOfferRedemptionLimits = {
  maxRedemptions?: number | null;
  maxPerMember?: number | null;
};

export type CatalogOffer = {
  offerKey: string;
  /** Normalized customer-facing code (trimmed, uppercased). */
  code: string;
  targetPriceKey: string;
  enabled: boolean;
  startDate?: string | null;
  endDate?: string | null;
  newCustomersOnly?: boolean;
  redemptionLimits?: CatalogOfferRedemptionLimits | null;
};

export type BillingCatalog = {
  version: number;
  defaultTierKey: string;
  defaultPriceKey: string;
  prices: CatalogPrice[];
  offers: CatalogOffer[];
};

const CADENCES: BillingCadence[] = ["monthly", "quarterly", "yearly", "custom"];

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function normalizeOfferCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function logCatalogEvent(status: string, reason: string, extra?: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      event: "billing_catalog",
      status,
      reason,
      ...(extra || {}),
    })
  );
}

function parseCatalogJson(raw: string): BillingCatalog | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    logCatalogEvent(
      "invalid_json",
      "BILLING_CATALOG_JSON could not be parsed; falling back to legacy env config",
      { error: e instanceof Error ? e.message : String(e) }
    );
    return null;
  }
  if (!isRecord(json)) {
    logCatalogEvent("invalid_json", "BILLING_CATALOG_JSON must be a JSON object");
    return null;
  }

  const rawPrices = Array.isArray(json.prices) ? json.prices : [];
  const prices: CatalogPrice[] = [];
  const seenKeys = new Set<string>();

  for (const p of rawPrices) {
    if (!isRecord(p)) continue;
    const priceKey = str(p.priceKey);
    const tierKey = str(p.tierKey) || "standard";
    if (!priceKey) continue;
    if (seenKeys.has(priceKey)) {
      logCatalogEvent("invalid_price", `Duplicate priceKey: ${priceKey}`);
      continue;
    }
    const cadenceRaw = str(p.cadence).toLowerCase() as BillingCadence;
    const memberstackPriceId = str(p.memberstackPriceId) || undefined;
    const stripePriceId = str(p.stripePriceId) || undefined;
    if (!memberstackPriceId && !stripePriceId) {
      logCatalogEvent("invalid_price", `priceKey ${priceKey} has no Stripe/Memberstack id`);
      continue;
    }
    seenKeys.add(priceKey);
    prices.push({
      priceKey,
      tierKey,
      cadence: CADENCES.includes(cadenceRaw) ? cadenceRaw : "custom",
      intervalCount: num(p.intervalCount),
      memberstackPriceId,
      stripePriceId,
      sellable: bool(p.sellable, false),
      legacy: bool(p.legacy, false),
      eligibleForSignup: bool(p.eligibleForSignup, !bool(p.legacy, false)),
      eligibleForReactivation: bool(p.eligibleForReactivation, false),
      label: str(p.label) || undefined,
      description: str(p.description) || undefined,
      trialDays: num(p.trialDays),
      amountUsd: num(p.amountUsd),
    });
  }

  if (prices.length === 0) {
    logCatalogEvent("invalid_catalog", "BILLING_CATALOG_JSON has no valid prices");
    return null;
  }

  const defaultPriceKey = str(json.defaultPriceKey);
  const catalog: BillingCatalog = {
    version: typeof json.version === "number" ? json.version : 1,
    defaultTierKey: str(json.defaultTierKey) || prices[0].tierKey,
    defaultPriceKey: prices.some((p) => p.priceKey === defaultPriceKey)
      ? defaultPriceKey
      : prices.find((p) => p.sellable && p.eligibleForSignup)?.priceKey || prices[0].priceKey,
    prices,
    offers: [],
  };

  if (Array.isArray(json.offers)) {
    for (const o of json.offers) {
      if (!isRecord(o)) continue;
      const code = normalizeOfferCode(str(o.code));
      const targetPriceKey = str(o.targetPriceKey);
      if (!code || !targetPriceKey) {
        logCatalogEvent("invalid_offer", "Offer missing code or targetPriceKey");
        continue;
      }
      catalog.offers.push({
        offerKey: str(o.offerKey) || code.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        code,
        targetPriceKey,
        enabled: bool(o.enabled, false),
        startDate: str(o.startDate) || null,
        endDate: str(o.endDate) || null,
        newCustomersOnly: bool(o.newCustomersOnly, false),
        redemptionLimits: isRecord(o.redemptionLimits)
          ? {
              maxRedemptions:
                typeof o.redemptionLimits.maxRedemptions === "number"
                  ? o.redemptionLimits.maxRedemptions
                  : null,
              maxPerMember:
                typeof o.redemptionLimits.maxPerMember === "number"
                  ? o.redemptionLimits.maxPerMember
                  : null,
            }
          : null,
      });
    }
  }

  return catalog;
}

/**
 * Migration catalog built from the legacy env vars. Produces behavior
 * equivalent to the previous single-price configuration.
 */
function catalogFromLegacyEnv(): BillingCatalog {
  const stripeRaw = (process.env.STRIPE_MEMBERSHIP_PRICE_IDS || "").trim();
  const reactivation = (process.env.STRIPE_REACTIVATION_PRICE_ID || "").trim();
  const msPrice = (process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID || "").trim();
  const msPlan = (process.env.MEMBERSTACK_PLAN_ID || "").trim();

  const prices: CatalogPrice[] = [];
  const rawIds = splitCsv(stripeRaw);
  const nativeIds = rawIds.filter((id) => id.startsWith("price_"));
  const rawCommerceIds = rawIds.filter(
    (id) => id.startsWith("prc_") || id.startsWith("pln_")
  );

  const defaultStripeId = reactivation.startsWith("price_")
    ? reactivation
    : nativeIds[0] || "";
  const defaultMsId =
    msPrice.startsWith("prc_") || msPrice.startsWith("pln_") ? msPrice : "";

  let defaultPriceKey = "";
  if (defaultStripeId || defaultMsId) {
    const entry: CatalogPrice = {
      priceKey: "standard_default_legacy",
      tierKey: "standard",
      cadence: "quarterly",
      intervalCount: 3,
      memberstackPriceId: defaultMsId || undefined,
      stripePriceId: defaultStripeId || undefined,
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: true,
      label: "Standard membership",
    };
    prices.push(entry);
    defaultPriceKey = entry.priceKey;
  }

  for (const id of nativeIds) {
    if (id === defaultStripeId) continue;
    prices.push({
      priceKey: `legacy_${id}`,
      tierKey: "standard",
      cadence: "custom",
      stripePriceId: id,
      sellable: false,
      legacy: true,
      eligibleForSignup: false,
      eligibleForReactivation: false,
    });
  }

  const attached = new Set([defaultMsId]);
  for (const id of dedupePreserveOrder([...rawCommerceIds, msPrice, msPlan])) {
    if (!id) continue;
    if (attached.has(id)) continue;
    attached.add(id);
    prices.push({
      priceKey: `legacy_${id}`,
      tierKey: "standard",
      cadence: "custom",
      memberstackPriceId: id,
      sellable: false,
      legacy: true,
      eligibleForSignup: false,
      eligibleForReactivation: false,
    });
  }

  if (prices.length === 0) {
    return {
      version: 1,
      defaultTierKey: "standard",
      defaultPriceKey: "",
      prices: [],
      offers: [],
    };
  }

  if (!defaultPriceKey) {
    defaultPriceKey = prices[0].priceKey;
  }

  return {
    version: 1,
    defaultTierKey: "standard",
    defaultPriceKey,
    prices,
    offers: [],
  };
}

let cachedCatalog: BillingCatalog | null = null;
let cachedSignature = "";

function envSignature(): string {
  return JSON.stringify([
    process.env.BILLING_CATALOG_JSON || "",
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS || "",
    process.env.STRIPE_REACTIVATION_PRICE_ID || "",
    process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID || "",
    process.env.MEMBERSTACK_PLAN_ID || "",
  ]);
}

export function getBillingCatalog(): BillingCatalog {
  const signature = envSignature();
  if (cachedCatalog && cachedSignature === signature) return cachedCatalog;

  const rawJson = (process.env.BILLING_CATALOG_JSON || "").trim();
  const catalog = (rawJson ? parseCatalogJson(rawJson) : null) || catalogFromLegacyEnv();
  cachedCatalog = catalog;
  cachedSignature = signature;
  return catalog;
}

export function resetBillingCatalogCache(): void {
  cachedCatalog = null;
  cachedSignature = "";
}

export function resolveCatalogEntryByPriceKey(priceKey: string): CatalogPrice | null {
  const key = priceKey.trim();
  if (!key) return null;
  return getBillingCatalog().prices.find((p) => p.priceKey === key) || null;
}

export function resolveCatalogEntryByStripePriceId(
  stripePriceId: string
): CatalogPrice | null {
  const id = stripePriceId.trim();
  if (!id) return null;
  return getBillingCatalog().prices.find((p) => p.stripePriceId === id) || null;
}

export function resolveCatalogEntryByMemberstackPriceId(
  memberstackPriceId: string
): CatalogPrice | null {
  const id = memberstackPriceId.trim();
  if (!id) return null;
  return getBillingCatalog().prices.find((p) => p.memberstackPriceId === id) || null;
}

/** All native Stripe price_ ids in the catalog (active + legacy retention). */
export function nativeMembershipPriceAllowlist(): Set<string> {
  const set = new Set<string>();
  for (const p of getBillingCatalog().prices) {
    if (p.stripePriceId && p.stripePriceId.startsWith("price_")) set.add(p.stripePriceId);
  }
  return set;
}

/** Current default price used for plain signup checkout. */
export function getDefaultSignupPrice(): CatalogPrice | null {
  const c = getBillingCatalog();
  return (
    resolveCatalogEntryByPriceKey(c.defaultPriceKey) ||
    c.prices.find((p) => p.sellable && p.eligibleForSignup) ||
    null
  );
}

/** Current price used whenever a NEW subscription is created (rejoin path). */
export function getReactivationPrice(): CatalogPrice | null {
  const c = getBillingCatalog();
  const def = resolveCatalogEntryByPriceKey(c.defaultPriceKey);
  if (def && def.sellable && def.eligibleForReactivation && def.stripePriceId) {
    return def;
  }
  return (
    c.prices.find((p) => p.sellable && p.eligibleForReactivation && p.stripePriceId) ||
    null
  );
}

/**
 * Memberstack commerce id (prc_…) for a given native Stripe price id.
 * Empty string when the price is not mapped — callers must NOT substitute
 * an unrelated default in that case.
 */
export function getMemberstackPlanIdForStripePrice(stripePriceId: string): string {
  return resolveCatalogEntryByStripePriceId(stripePriceId)?.memberstackPriceId || "";
}

export type OfferResolution =
  | {
      ok: true;
      offerCode: string;
      offer: CatalogOffer;
      price: CatalogPrice;
    }
  | {
      ok: false;
      status:
        | "unknown"
        | "disabled"
        | "expired"
        | "not_started"
        | "new_customers_only"
        | "unavailable";
      reason: string;
    };

/**
 * Resolve a customer-facing promo code to its target catalog price.
 * Invalid/disabled codes never resolve — callers must not fall back to the
 * default price on failure.
 */
export function resolveOffer(
  rawCode: string,
  options?: { now?: Date; newCustomer?: boolean }
): OfferResolution {
  const code = normalizeOfferCode(rawCode);
  if (!code) {
    return { ok: false, status: "unknown", reason: "Empty promo code" };
  }

  const catalog = getBillingCatalog();
  const offer = catalog.offers.find((o) => normalizeOfferCode(o.code) === code);
  if (!offer) {
    return { ok: false, status: "unknown", reason: `Unknown promo code: ${code}` };
  }
  if (!offer.enabled) {
    return { ok: false, status: "disabled", reason: `Promo code disabled: ${code}` };
  }

  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  if (offer.startDate) {
    const start = Date.parse(offer.startDate);
    if (Number.isFinite(start) && nowMs < start) {
      return { ok: false, status: "not_started", reason: `Promo code not active yet: ${code}` };
    }
  }
  if (offer.endDate) {
    const end = Date.parse(offer.endDate);
    if (Number.isFinite(end) && nowMs > end) {
      return { ok: false, status: "expired", reason: `Promo code expired: ${code}` };
    }
  }
  if (offer.newCustomersOnly && options?.newCustomer === false) {
    return {
      ok: false,
      status: "new_customers_only",
      reason: `Promo code is new-customers-only: ${code}`,
    };
  }

  const price = resolveCatalogEntryByPriceKey(offer.targetPriceKey);
  if (!price) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Promo code target price not in catalog: ${offer.targetPriceKey}`,
    };
  }
  if (!price.sellable || !price.eligibleForSignup) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Promo code target price not sellable: ${offer.targetPriceKey}`,
    };
  }

  return { ok: true, offerCode: code, offer, price };
}
