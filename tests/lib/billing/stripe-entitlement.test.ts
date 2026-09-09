import { describe, it, expect, vi } from "vitest";
import { calculateStripeEntitlement } from "@/lib/billing/stripe-entitlement";

const TRIAL_END = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);
const LATER_END = Math.floor(new Date("2026-10-01T00:00:00.000Z").getTime() / 1000);
const NOW = Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000);

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_t",
    status: "trialing",
    cancel_at_period_end: false,
    current_period_end: TRIAL_END,
    items: {
      data: [{ current_period_end: TRIAL_END, price: { id: "price_trial" } }],
    },
    ...overrides,
  } as never;
}

function invoiceLine(priceId: string, end: number) {
  return {
    id: "il_1",
    period: { start: end - 30 * 86400, end },
    pricing: { price_details: { price: priceId } },
  } as never;
}

function mockStripe(subs: unknown[] = [], invoiceEnd?: number) {
  return {
    invoices: {
      list: vi.fn(async () => ({
        data:
          invoiceEnd == null
            ? []
            : [{ id: "in_1", status: "paid", amount_paid: 8700 }],
        has_more: false,
      })),
      listLineItems: vi.fn(async () => ({
        data: invoiceEnd == null ? [] : [invoiceLine("price_trial", invoiceEnd)],
        has_more: false,
      })),
    },
    subscriptions: {
      list: vi.fn(async () => ({ data: subs })),
    },
  };
}

async function entitlement(subs: unknown[], allow: Set<string>, invoiceEnd?: number) {
  return calculateStripeEntitlement({
    stripe: mockStripe(subs, invoiceEnd) as never,
    stripeCustomerId: "cus_trial",
    membershipPriceIds: allow,
    nowUnix: NOW,
  });
}

describe("calculateStripeEntitlement trialing promotion", () => {
  it("promotes a trialing subscription on an allowlisted price to the trial period end", async () => {
    const ent = await entitlement([subscription()], new Set(["price_trial"]));
    expect(ent.hasEntitlementNow).toBe(true);
    expect(ent.paidThroughIso).toBe("2026-09-01T00:00:00.000Z");
    expect(ent.notes).toContain(
      "Trialing subscription — paid-through promoted to trial period end (no paid invoice yet)"
    );
  });

  it("does not promote a trialing subscription whose price is not allowlisted", async () => {
    const ent = await entitlement([subscription()], new Set(["price_other"]));
    expect(ent.paidThroughIso).toBeNull();
    expect(ent.hasEntitlementNow).toBe(false);
  });

  it("reports an expired trial as not entitled while keeping the paid-through date", async () => {
    const pastEnd = Math.floor(new Date("2026-07-01T00:00:00.000Z").getTime() / 1000);
    const ent = await entitlement(
      [subscription({ current_period_end: pastEnd })],
      new Set(["price_trial"])
    );
    expect(ent.paidThroughIso).toBe("2026-07-01T00:00:00.000Z");
    expect(ent.hasEntitlementNow).toBe(false);
  });

  it("does not promote past_due subscriptions", async () => {
    const ent = await entitlement(
      [subscription({ status: "past_due" })],
      new Set(["price_trial"])
    );
    expect(ent.paidThroughIso).toBeNull();
    expect(ent.hasEntitlementNow).toBe(false);
  });

  it("keeps a later paid-invoice period end over the trial period end", async () => {
    const ent = await entitlement(
      [subscription()],
      new Set(["price_trial"]),
      LATER_END
    );
    expect(ent.paidThroughIso).toBe("2026-10-01T00:00:00.000Z");
  });

  it("promotes the trial period end over an earlier paid-invoice period end", async () => {
    const earlyEnd = Math.floor(new Date("2026-08-15T00:00:00.000Z").getTime() / 1000);
    const ent = await entitlement(
      [subscription()],
      new Set(["price_trial"]),
      earlyEnd
    );
    expect(ent.paidThroughIso).toBe("2026-09-01T00:00:00.000Z");
  });

  it("still promotes active subscriptions to their current period end", async () => {
    const ent = await entitlement(
      [subscription({ status: "active" })],
      new Set(["price_trial"])
    );
    expect(ent.paidThroughIso).toBe("2026-09-01T00:00:00.000Z");
    expect(ent.hasEntitlementNow).toBe(true);
  });

  it("does not promote a pause-collection subscription despite status active", async () => {
    const ent = await entitlement(
      [subscription({ status: "active", pause_collection: { resumes_at: null } })],
      new Set(["price_trial"])
    );
    expect(ent.paidThroughIso).toBeNull();
    expect(ent.hasEntitlementNow).toBe(false);
  });

  it("reports a pause-collection subscription as paused in the primary snapshot", async () => {
    const ent = await entitlement(
      [subscription({ status: "active", pause_collection: { resumes_at: 1999999999 } })],
      new Set(["price_trial"])
    );
    expect(ent.primarySubscription?.status).toBe("paused");
    expect(ent.primarySubscription?.pauseCollection).toBe(true);
  });

  it("ranks a pause-collection sub below an active sub when both exist", async () => {
    const ent = await entitlement(
      [
        subscription({
          id: "sub_paused",
          status: "active",
          pause_collection: { resumes_at: null },
          current_period_end: LATER_END,
        }),
        subscription({ id: "sub_active", status: "active" }),
      ],
      new Set(["price_trial"])
    );
    expect(ent.primarySubscription?.id).toBe("sub_active");
  });
});
