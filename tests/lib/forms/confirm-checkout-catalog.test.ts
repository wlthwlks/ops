import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

const retrieveSession = vi.fn();
const listInvoices = vi.fn();
const listLineItems = vi.fn();
const listSubscriptions = vi.fn();
const retrieveSubscription = vi.fn();
const listCustomers = vi.fn();

const stripeMock = {
  checkout: { sessions: { retrieve: retrieveSession, listLineItems: vi.fn() } },
  invoices: { list: listInvoices, listLineItems },
  subscriptions: { list: listSubscriptions, retrieve: retrieveSubscription },
  customers: { list: listCustomers },
};

vi.mock("@/lib/integrations/stripe", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/integrations/stripe")>();
  return {
    ...original,
    getStripeClient: () => stripeMock,
  };
});

const findByMs = vi.fn();
const applyTrusted = vi.fn();
const linkCustomer = vi.fn();

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  findMemberByMemberstackId: (...a: unknown[]) => findByMs(...a),
  applyTrustedPaymentByMemberstackId: (...a: unknown[]) => applyTrusted(...a),
  linkStripeCustomerIdByMemberstackId: (...a: unknown[]) => linkCustomer(...a),
}));

const CATALOG_JSON = JSON.stringify({
  version: 1,
  defaultTierKey: "standard",
  defaultPriceKey: "standard_quarterly_default",
  prices: [
    {
      priceKey: "standard_quarterly_default",
      tierKey: "standard",
      cadence: "quarterly",
      stripePriceId: "price_default_87",
      memberstackPriceId: "prc_default_87",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: true,
    },
    {
      priceKey: "standard_quarterly_founders45",
      tierKey: "standard",
      cadence: "quarterly",
      stripePriceId: "price_founders45",
      memberstackPriceId: "prc_founders45",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: false,
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
  ],
  offers: [],
});

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv() {
  for (const k of [
    "BILLING_CATALOG_JSON",
    "STRIPE_MEMBERSHIP_PRICE_IDS",
    "STRIPE_REACTIVATION_PRICE_ID",
    "MEMBERSTACK_MEMBERSHIP_PRICE_ID",
    "MEMBERSTACK_PLAN_ID",
    "VERCEL_ENV",
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

function line(priceId: string, periodEnd: number) {
  return {
    id: "il_1",
    period: { start: periodEnd - 100, end: periodEnd },
    pricing: { price_details: { price: priceId } },
  };
}

function invoice(invoiceId: string, paidAtUnix: number, periodEnd: number, priceId: string) {
  return {
    id: invoiceId,
    status_transitions: { paid_at: paidAtUnix },
    amount_paid: 8700,
    period: { end: periodEnd },
    pricing: { price_details: { price: priceId } },
  };
}

function sub(status: string, priceId: string, periodEnd: number) {
  return {
    id: "sub_1",
    status,
    created: Math.floor(Date.now() / 1000),
    items: { data: [{ price: { id: priceId }, current_period_end: periodEnd }] },
    current_period_end: periodEnd,
  };
}

const NOW = Math.floor(Date.now() / 1000);
const PERIOD_END = NOW + 90 * 86400;

describe("confirmCheckoutForMember with billing catalog", () => {
  beforeEach(() => {
    saveEnv();
    process.env.BILLING_CATALOG_JSON = CATALOG_JSON;
    delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
    delete process.env.STRIPE_REACTIVATION_PRICE_ID;
    delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    delete process.env.MEMBERSTACK_PLAN_ID;
    delete process.env.VERCEL_ENV;
    vi.clearAllMocks();
    listInvoices.mockResolvedValue({ data: [], has_more: false });
    listLineItems.mockResolvedValue({ data: [], has_more: false });
    listSubscriptions.mockResolvedValue({ data: [] });
    listCustomers.mockResolvedValue({ data: [] });
    applyTrusted.mockResolvedValue({
      record: { id: "rec1", fields: {} },
      status: "updated",
      shadowed: false,
    });
    linkCustomer.mockResolvedValue({ status: "linked" });
  });

  afterEach(() => {
    restoreEnv();
  });

  it("unrelated Stripe price fails closed even mid-signup (no passthrough)", async () => {
    const { confirmCheckoutForMember } = await import(
      "@/lib/forms/billing/confirm-checkout"
    );
    findByMs.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_x",
          [MEMBER_FIELDS.onboardingStatus]: "PAYMENT_PENDING",
        },
      },
    ]);
    listInvoices.mockResolvedValue({
      data: [invoice("in_1", NOW - 60, PERIOD_END, "price_unrelated")],
      has_more: false,
    });
    listLineItems.mockResolvedValue({
      data: [line("price_unrelated", PERIOD_END)],
      has_more: false,
    });
    listSubscriptions.mockResolvedValue({
      data: [sub("active", "price_unrelated", PERIOD_END)],
    });

    const r = await confirmCheckoutForMember({
      memberstackId: "mem_1",
      memberEmail: "a@b.com",
    });

    expect(r.paymentConfirmed).toBe(false);
    expect(r.status).not.toBe("already_paid");
    expect(r.qualificationMode).not.toBe("mid_signup_live_sub");
    expect(r.qualificationMode).not.toBe("mid_signup_price_passthrough");
    expect(applyTrusted).not.toHaveBeenCalled();
  });

  it("trialing subscription completes onboarding and grants service access", async () => {
    const { confirmCheckoutForMember } = await import(
      "@/lib/forms/billing/confirm-checkout"
    );
    findByMs.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_x",
          [MEMBER_FIELDS.onboardingStatus]: "PAYMENT_PENDING",
        },
      },
    ]);
    listSubscriptions.mockResolvedValue({
      data: [sub("trialing", "price_default_87", PERIOD_END)],
    });
    retrieveSubscription.mockResolvedValue(sub("trialing", "price_default_87", PERIOD_END));

    const r = await confirmCheckoutForMember({
      memberstackId: "mem_1",
      memberEmail: "a@b.com",
    });

    expect(r.paymentConfirmed).toBe(true);
    expect(r.status).toBe("updated");
    const patch = applyTrusted.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch[MEMBER_FIELDS.onboardingStatus]).toBe("PAYMENT_CONFIRMED");
    expect(patch[MEMBER_FIELDS.serviceAccessUntil]).toBe(
      new Date(PERIOD_END * 1000).toISOString().slice(0, 10)
    );
    expect(patch[MEMBER_FIELDS.stripeSubscriptionStatus]).toBe("trialing");
    expect(patch[MEMBER_FIELDS.stripePriceId]).toBe("price_default_87");
    expect(patch[MEMBER_FIELDS.memberstackPlanId]).toBe("prc_default_87");
  });

  it("grandfathered member retains old price and gets the mapped Memberstack plan id", async () => {
    const { confirmCheckoutForMember } = await import(
      "@/lib/forms/billing/confirm-checkout"
    );
    findByMs.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_x",
          [MEMBER_FIELDS.onboardingStatus]: "COMPLETE",
        },
      },
    ]);
    listInvoices.mockResolvedValue({
      data: [invoice("in_legacy", NOW - 60, PERIOD_END, "price_legacy_old")],
      has_more: false,
    });
    listLineItems.mockResolvedValue({
      data: [line("price_legacy_old", PERIOD_END)],
      has_more: false,
    });
    listSubscriptions.mockResolvedValue({ data: [] });

    const r = await confirmCheckoutForMember({
      memberstackId: "mem_1",
      memberEmail: "a@b.com",
    });

    expect(r.paymentConfirmed).toBe(true);
    const patch = applyTrusted.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch[MEMBER_FIELDS.stripePriceId]).toBe("price_legacy_old");
    expect(patch[MEMBER_FIELDS.memberstackPlanId]).toBe("prc_legacy_old");
    expect(patch[MEMBER_FIELDS.serviceAccessUntil]).toBe(
      new Date(PERIOD_END * 1000).toISOString().slice(0, 10)
    );
    expect(patch[MEMBER_FIELDS.onboardingStatus]).toBeUndefined();
  });
});
