import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseMembershipPriceConfig,
  hasNativeStripeMembershipPrices,
  getStripeNativeMembershipPriceIds,
} from "@/lib/integrations/stripe";
import {
  getQualifyingMembershipPriceIds,
  getMembershipPeriodEnd,
} from "@/lib/billing/service-access-sync";
import type Stripe from "stripe";

function line(priceId: string, periodEnd = 100): Stripe.InvoiceLineItem {
  return {
    id: "il_1",
    pricing: { price_details: { price: priceId } },
    period: { start: 1, end: periodEnd },
  } as unknown as Stripe.InvoiceLineItem;
}

describe("parseMembershipPriceConfig", () => {
  const prevStripe = process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
  const prevMs = process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
  const prevPlan = process.env.MEMBERSTACK_PLAN_ID;

  afterEach(() => {
    if (prevStripe === undefined) delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
    else process.env.STRIPE_MEMBERSHIP_PRICE_IDS = prevStripe;
    if (prevMs === undefined) delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    else process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = prevMs;
    if (prevPlan === undefined) delete process.env.MEMBERSTACK_PLAN_ID;
    else process.env.MEMBERSTACK_PLAN_ID = prevPlan;
  });

  it("parses one valid membership price", () => {
    const c = parseMembershipPriceConfig({
      stripeMembershipPriceIds: "price_abc",
      memberstackMembershipPriceId: "",
    });
    expect(c.nativeStripePriceIds).toEqual(["price_abc"]);
  });

  it("parses multiple valid prices and dedupes", () => {
    const c = parseMembershipPriceConfig({
      stripeMembershipPriceIds: "price_a, price_b, price_a",
    });
    expect(c.nativeStripePriceIds).toEqual(["price_a", "price_b"]);
  });

  it("separates price_ from prc_/pln_", () => {
    const c = parseMembershipPriceConfig({
      stripeMembershipPriceIds: "price_real, prc_ms",
      memberstackMembershipPriceId: "pln_other",
    });
    expect(c.nativeStripePriceIds).toEqual(["price_real"]);
    expect(c.memberstackCommerceIds).toEqual(["prc_ms", "pln_other"]);
  });

  it("handles whitespace", () => {
    const c = parseMembershipPriceConfig({
      stripeMembershipPriceIds: "  price_a ,  price_b  ",
    });
    expect(c.nativeStripePriceIds).toEqual(["price_a", "price_b"]);
  });

  it("empty configuration has no native prices", () => {
    const c = parseMembershipPriceConfig({
      stripeMembershipPriceIds: "",
      memberstackMembershipPriceId: "",
      memberstackPlanId: "",
    });
    expect(c.nativeStripePriceIds).toEqual([]);
    expect(hasNativeStripeMembershipPrices()).toBe(
      parseMembershipPriceConfig().nativeStripePriceIds.length > 0
    );
  });

  it("only prc_ configured → no native allowlist", () => {
    const c = parseMembershipPriceConfig({
      stripeMembershipPriceIds: "prc_only",
      memberstackMembershipPriceId: "",
    });
    expect(c.nativeStripePriceIds).toEqual([]);
    expect(c.memberstackCommerceIds).toEqual(["prc_only"]);
  });
});

describe("getQualifyingMembershipPriceIds fail-closed", () => {
  it("qualifies matching price", () => {
    const allow = new Set(["price_membership"]);
    expect(
      getQualifyingMembershipPriceIds([line("price_membership")], allow)
    ).toEqual(["price_membership"]);
  });

  it("rejects unrelated invoice price", () => {
    const allow = new Set(["price_membership"]);
    expect(getQualifyingMembershipPriceIds([line("price_other")], allow)).toEqual([]);
  });

  it("empty allowlist qualifies nothing (never allow-all)", () => {
    expect(
      getQualifyingMembershipPriceIds([line("price_anything")], new Set())
    ).toEqual([]);
  });

  it("only prc_ in set qualifies nothing on lines", () => {
    expect(
      getQualifyingMembershipPriceIds(
        [line("price_membership")],
        new Set(["prc_ms_only"])
      )
    ).toEqual([]);
  });

  it("invoice with multiple lines where one qualifies", () => {
    const allow = new Set(["price_membership"]);
    expect(
      getQualifyingMembershipPriceIds(
        [line("price_other"), line("price_membership"), line("price_extra")],
        allow
      )
    ).toEqual(["price_membership"]);
  });

  it("period end only from qualifying lines", () => {
    const allow = new Set(["price_membership"]);
    expect(
      getMembershipPeriodEnd(
        [line("price_other", 999), line("price_membership", 100)],
        allow
      )
    ).toBe(100);
    expect(getMembershipPeriodEnd([line("price_other", 999)], allow)).toBeNull();
  });
});

describe("getStripeNativeMembershipPriceIds production fail-closed", () => {
  const prevNode = process.env.NODE_ENV;
  const prevStripe = process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
  const prevMs = process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
  const prevPlan = process.env.MEMBERSTACK_PLAN_ID;
  const prevVercel = process.env.VERCEL_ENV;

  beforeEach(() => {
    delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
    delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    delete process.env.MEMBERSTACK_PLAN_ID;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = prevNode;
    if (prevStripe === undefined) delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
    else process.env.STRIPE_MEMBERSHIP_PRICE_IDS = prevStripe;
    if (prevMs === undefined) delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    else process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = prevMs;
    if (prevPlan === undefined) delete process.env.MEMBERSTACK_PLAN_ID;
    else process.env.MEMBERSTACK_PLAN_ID = prevPlan;
    if (prevVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prevVercel;
  });

  it("throws when requireConfigured and no native prices", () => {
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "prc_only";
    expect(() =>
      getStripeNativeMembershipPriceIds({
        requireConfigured: true,
        failClosedInProduction: false,
      })
    ).toThrow(/price_/);
  });
});
