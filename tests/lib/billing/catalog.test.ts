import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getBillingCatalog,
  getDefaultSignupPrice,
  getMemberstackPlanIdForStripePrice,
  getReactivationPrice,
  nativeMembershipPriceAllowlist,
  resetBillingCatalogCache,
  resolveCatalogEntryByPriceKey,
  resolveCatalogEntryByStripePriceId,
  resolveOffer,
} from "@/lib/billing/catalog";

const CATALOG_JSON = JSON.stringify({
  version: 1,
  defaultTierKey: "standard",
  defaultPriceKey: "standard_quarterly_default",
  prices: [
    {
      priceKey: "standard_quarterly_default",
      tierKey: "standard",
      cadence: "quarterly",
      intervalCount: 3,
      stripePriceId: "price_default_87",
      memberstackPriceId: "prc_default_87",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: true,
      label: "$87 every 3 months",
      amountUsd: 87,
    },
    {
      priceKey: "standard_quarterly_founders45",
      tierKey: "standard",
      cadence: "quarterly",
      intervalCount: 3,
      stripePriceId: "price_founders45",
      memberstackPriceId: "prc_founders45",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: false,
      label: "$45 every 3 months",
      description: "3 months free, then $45 every 3 months indefinitely",
      trialDays: 90,
      amountUsd: 45,
    },
    {
      priceKey: "standard_monthly",
      tierKey: "standard",
      cadence: "monthly",
      intervalCount: 1,
      stripePriceId: "price_monthly",
      memberstackPriceId: "prc_monthly",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: false,
      label: "$30 every month",
      amountUsd: 30,
    },
    {
      priceKey: "standard_yearly",
      tierKey: "standard",
      cadence: "yearly",
      intervalCount: 12,
      stripePriceId: "price_yearly",
      memberstackPriceId: "prc_yearly",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: false,
      label: "$300 every year",
      amountUsd: 300,
    },
    {
      priceKey: "standard_legacy_grandfathered",
      tierKey: "standard",
      cadence: "quarterly",
      stripePriceId: "price_legacy_old",
      memberstackPriceId: "prc_legacy_old",
      sellable: false,
      legacy: true,
      eligibleForSignup: false,
      eligibleForReactivation: false,
    },
    {
      priceKey: "basic_monthly",
      tierKey: "basic",
      cadence: "monthly",
      intervalCount: 1,
      stripePriceId: "price_basic_monthly",
      memberstackPriceId: "prc_basic_monthly",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: false,
      label: "Basic $15 every month",
      amountUsd: 15,
    },
  ],
  offers: [
    {
      offerKey: "founders45",
      code: "FOUNDERS45",
      targetPriceKey: "standard_quarterly_founders45",
      enabled: true,
      newCustomersOnly: true,
      startDate: null,
      endDate: null,
      redemptionLimits: null,
    },
    {
      offerKey: "disabled_offer",
      code: "OLDCODE",
      targetPriceKey: "standard_quarterly_default",
      enabled: false,
    },
    {
      offerKey: "expired_offer",
      code: "EXPIRED",
      targetPriceKey: "standard_quarterly_default",
      enabled: true,
      startDate: "2024-01-01T00:00:00.000Z",
      endDate: "2024-12-31T23:59:59.000Z",
    },
  ],
});

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv() {
  for (const k of [
    "BILLING_CATALOG_JSON",
    "STRIPE_MEMBERSHIP_PRICE_IDS",
    "STRIPE_REACTIVATION_PRICE_ID",
    "MEMBERSTACK_MEMBERSHIP_PRICE_ID",
    "MEMBERSTACK_PLAN_ID",
  ]) {
    SAVED_ENV[k] = process.env[k];
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  saveEnv();
  resetBillingCatalogCache();
  process.env.BILLING_CATALOG_JSON = CATALOG_JSON;
  delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
  delete process.env.STRIPE_REACTIVATION_PRICE_ID;
  delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
  delete process.env.MEMBERSTACK_PLAN_ID;
});

afterEach(() => {
  restoreEnv();
  resetBillingCatalogCache();
});

describe("Billing Catalog", () => {
  it("default signup price resolves with no code (default $87 quarterly)", () => {
    const p = getDefaultSignupPrice();
    expect(p?.priceKey).toBe("standard_quarterly_default");
    expect(p?.stripePriceId).toBe("price_default_87");
    expect(p?.memberstackPriceId).toBe("prc_default_87");
    expect(p?.amountUsd).toBe(87);
  });

  it("resolveOffer accepts FOUNDERS45 case-insensitive and trimmed", () => {
    for (const raw of ["FOUNDERS45", " founders45 ", "founders45"]) {
      const r = resolveOffer(raw, { newCustomer: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.price.priceKey).toBe("standard_quarterly_founders45");
        expect(r.price.memberstackPriceId).toBe("prc_founders45");
      }
    }
  });

  it("resolveOffer resolves the special Memberstack price for FOUNDERS45", () => {
    const r = resolveOffer("founders45", { newCustomer: true });
    expect(r).toMatchObject({
      ok: true,
      offerCode: "FOUNDERS45",
    });
    if (r.ok) {
      expect(r.price.memberstackPriceId).toBe("prc_founders45");
      expect(r.price.stripePriceId).toBe("price_founders45");
      expect(r.price.description).toContain("3 months free, then $45");
    }
  });

  it("invalid code does not resolve (never falls back to default price)", () => {
    const r = resolveOffer("NOPE123", { newCustomer: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("unknown");
  });

  it("disabled code does not resolve", () => {
    const r = resolveOffer("oldcode", { newCustomer: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("disabled");
  });

  it("expired code does not resolve", () => {
    const r = resolveOffer("expired", { now: new Date("2026-01-01T00:00:00.000Z") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("expired");
  });

  it("new-customers-only code rejects existing customers", () => {
    const r = resolveOffer("founders45", { newCustomer: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("new_customers_only");
  });

  it("multiple cadences for the same tier resolve without special-case code", () => {
    const quarterly = resolveCatalogEntryByPriceKey("standard_quarterly_default");
    const monthly = resolveCatalogEntryByPriceKey("standard_monthly");
    const yearly = resolveCatalogEntryByPriceKey("standard_yearly");
    expect(quarterly?.cadence).toBe("quarterly");
    expect(monthly?.cadence).toBe("monthly");
    expect(yearly?.cadence).toBe("yearly");
    expect(quarterly?.tierKey).toBe("standard");
    expect(monthly?.tierKey).toBe("standard");
    expect(yearly?.tierKey).toBe("standard");
  });

  it("generic second tier fixture works without billing-flow changes", () => {
    const basic = resolveCatalogEntryByPriceKey("basic_monthly");
    expect(basic?.tierKey).toBe("basic");
    expect(basic?.cadence).toBe("monthly");
    expect(basic?.stripePriceId).toBe("price_basic_monthly");
    expect(basic?.memberstackPriceId).toBe("prc_basic_monthly");
  });

  it("native allowlist contains active AND legacy retention prices", () => {
    const allow = nativeMembershipPriceAllowlist();
    expect(allow.has("price_default_87")).toBe(true);
    expect(allow.has("price_founders45")).toBe(true);
    expect(allow.has("price_legacy_old")).toBe(true);
    expect(allow.has("price_unrelated")).toBe(false);
  });

  it("grandfathered price is retained for qualification but not sellable", () => {
    const legacy = resolveCatalogEntryByStripePriceId("price_legacy_old");
    expect(legacy?.legacy).toBe(true);
    expect(legacy?.sellable).toBe(false);
    expect(legacy?.eligibleForReactivation).toBe(false);
    expect(nativeMembershipPriceAllowlist().has("price_legacy_old")).toBe(true);
  });

  it("reactivation price excludes legacy and non-reactivation-eligible prices", () => {
    const r = getReactivationPrice();
    expect(r?.priceKey).toBe("standard_quarterly_default");
    expect(r?.stripePriceId).toBe("price_default_87");
  });

  it("Memberstack plan id resolves from actual Stripe price, empty for unknown", () => {
    expect(getMemberstackPlanIdForStripePrice("price_founders45")).toBe("prc_founders45");
    expect(getMemberstackPlanIdForStripePrice("price_legacy_old")).toBe("prc_legacy_old");
    expect(getMemberstackPlanIdForStripePrice("price_unrelated")).toBe("");
  });

  it("invalid BILLING_CATALOG_JSON falls back to legacy env migration", () => {
    process.env.BILLING_CATALOG_JSON = "{ not json";
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "price_legacy_xxx,price_new_yyy";
    process.env.STRIPE_REACTIVATION_PRICE_ID = "price_new_yyy";
    process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = "prc_primary";
    const c = getBillingCatalog();
    expect(c.defaultPriceKey).toBe("standard_default_legacy");
    const def = getDefaultSignupPrice();
    expect(def?.stripePriceId).toBe("price_new_yyy");
    expect(def?.memberstackPriceId).toBe("prc_primary");
    const allow = nativeMembershipPriceAllowlist();
    expect(allow.has("price_legacy_xxx")).toBe(true);
    expect(allow.has("price_new_yyy")).toBe(true);
  });
});

describe("legacy env migration", () => {
  beforeEach(() => {
    saveEnv();
    resetBillingCatalogCache();
    delete process.env.BILLING_CATALOG_JSON;
  });

  afterEach(() => {
    restoreEnv();
    resetBillingCatalogCache();
  });

  it("builds a catalog equivalent to the previous single-price config", () => {
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "price_legacy_xxx";
    process.env.STRIPE_REACTIVATION_PRICE_ID = "price_new_yyy";
    process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = "prc_primary";
    const c = getBillingCatalog();
    expect(c.prices.map((p) => p.priceKey)).toContain("standard_default_legacy");
    expect(c.prices.map((p) => p.priceKey)).toContain("legacy_price_legacy_xxx");
    expect(getDefaultSignupPrice()?.memberstackPriceId).toBe("prc_primary");
    expect(getReactivationPrice()?.stripePriceId).toBe("price_new_yyy");
    expect(nativeMembershipPriceAllowlist().has("price_legacy_xxx")).toBe(true);
  });

  it("prc_-only preview config yields empty native allowlist", () => {
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "";
    process.env.STRIPE_REACTIVATION_PRICE_ID = "";
    process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = "prc_preview_only";
    const c = getBillingCatalog();
    expect(nativeMembershipPriceAllowlist().size).toBe(0);
    expect(getDefaultSignupPrice()?.memberstackPriceId).toBe("prc_preview_only");
    expect(c.prices.length).toBeGreaterThan(0);
  });

  it("no configuration yields an empty catalog", () => {
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "";
    process.env.STRIPE_REACTIVATION_PRICE_ID = "";
    process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = "";
    process.env.MEMBERSTACK_PLAN_ID = "";
    const c = getBillingCatalog();
    expect(c.prices).toEqual([]);
    expect(getDefaultSignupPrice()).toBeNull();
    expect(nativeMembershipPriceAllowlist().size).toBe(0);
  });
});
