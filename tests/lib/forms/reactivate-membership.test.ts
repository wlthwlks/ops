import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMemberByMemberstackId = vi.fn();
const applyTrustedPaymentByMemberstackId = vi.fn();
const subscriptionsList = vi.fn();
const subscriptionsUpdate = vi.fn();
const subscriptionsCreate = vi.fn();
const subscriptionsRetrieve = vi.fn();
const subscriptionsCancel = vi.fn();
const customersRetrieve = vi.fn();
const customersUpdate = vi.fn();
const customersList = vi.fn();
const paymentMethodsList = vi.fn();
const pricesList = vi.fn();
const calculateStripeEntitlement = vi.fn();

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  findMemberByMemberstackId: (...a: unknown[]) => findMemberByMemberstackId(...a),
  applyTrustedPaymentByMemberstackId: (...a: unknown[]) =>
    applyTrustedPaymentByMemberstackId(...a),
}));

vi.mock("@/lib/billing/stripe-entitlement", () => ({
  calculateStripeEntitlement: (...a: unknown[]) => calculateStripeEntitlement(...a),
}));

vi.mock("@/lib/integrations/stripe", () => ({
  getStripeClient: () => ({
    subscriptions: {
      list: (...a: unknown[]) => subscriptionsList(...a),
      update: (...a: unknown[]) => subscriptionsUpdate(...a),
      create: (...a: unknown[]) => subscriptionsCreate(...a),
      retrieve: (...a: unknown[]) => subscriptionsRetrieve(...a),
      cancel: (...a: unknown[]) => subscriptionsCancel(...a),
    },
    customers: {
      retrieve: (...a: unknown[]) => customersRetrieve(...a),
      update: (...a: unknown[]) => customersUpdate(...a),
      list: (...a: unknown[]) => customersList(...a),
    },
    paymentMethods: {
      list: (...a: unknown[]) => paymentMethodsList(...a),
    },
    prices: {
      list: (...a: unknown[]) => pricesList(...a),
    },
  }),
  getConfiguredMembershipPriceIds: () =>
    new Set(["price_legacy", "price_new"]),
  getConfiguredMemberstackPlanId: () => "prc_plan",
}));

vi.mock("@/lib/billing/service-access-sync", () => ({
  formatPaidPlansText: (ids: string[]) => ids.filter(Boolean).join(", "),
}));

import { reactivateMembershipForMember } from "@/lib/forms/billing/reactivate-membership";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

function membershipLine(priceId: string, periodEnd?: number) {
  return {
    data: [{ price: { id: priceId }, ...(periodEnd ? { current_period_end: periodEnd } : {}) }],
  };
}

describe("reactivateMembershipForMember", () => {
  const prevPrice = process.env.STRIPE_REACTIVATION_PRICE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_REACTIVATION_PRICE_ID = "price_new";
    findMemberByMemberstackId.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_test",
          [MEMBER_FIELDS.memberstackId]: "mem_1",
        },
      },
    ]);
    applyTrustedPaymentByMemberstackId.mockResolvedValue({
      record: { id: "rec1", fields: {} },
      shadowed: false,
    });
    calculateStripeEntitlement.mockResolvedValue({ qualifyingPayments: [] });
    pricesList.mockResolvedValue({ data: [{ id: "price_new", unit_amount: 4500 }] });
    customersRetrieve.mockResolvedValue({
      id: "cus_test",
      invoice_settings: { default_payment_method: "pm_card" },
    });
    customersList.mockResolvedValue({ data: [] });
    paymentMethodsList.mockResolvedValue({ data: [{ id: "pm_card" }] });
    customersUpdate.mockResolvedValue({});
    subscriptionsRetrieve.mockRejectedValue(new Error("not found"));
  });

  afterEach(() => {
    if (prevPrice === undefined) delete process.env.STRIPE_REACTIVATION_PRICE_ID;
    else process.env.STRIPE_REACTIVATION_PRICE_ID = prevPrice;
  });

  it("active + cancel_at_period_end: reverses cancel only — no create/checkout charge", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_pending",
          status: "active",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy", 1735689600),
          current_period_end: 1735689600,
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_pending",
      status: "active",
      cancel_at_period_end: false,
      items: membershipLine("price_legacy", 1735689600),
      current_period_end: 1735689600,
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(true);
    expect(result.status).toBe("cancellation_reversed");
    expect(result.charged).toBe(false);
    expect(result.message).toBeTruthy();
    expect(result.message).toContain("not be charged today");
    expect(result.nextRenewalDate).toBeTruthy();
    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_pending", {
      cancel_at_period_end: false,
    });
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(applyTrustedPaymentByMemberstackId).toHaveBeenCalled();
    const patch = applyTrustedPaymentByMemberstackId.mock.calls[0][0]
      .patch as Record<string, unknown>;
    // Keeps the existing subscription's original native price in "Stripe Price ID".
    expect(patch[MEMBER_FIELDS.stripePriceId]).toBe("price_legacy");
    expect(patch[MEMBER_FIELDS.memberstackPlanId]).toBe("prc_plan");
  });

  it("active + cancel_at timestamp: clears cancel without combining cancel_at params", async () => {
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_cancel_at",
          status: "active",
          cancel_at_period_end: false,
          cancel_at: future,
          items: membershipLine("price_legacy", future),
          current_period_end: future,
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_cancel_at",
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      items: membershipLine("price_legacy", future),
      current_period_end: future,
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(true);
    expect(result.status).toBe("cancellation_reversed");
    expect(result.charged).toBe(false);
    expect(subscriptionsUpdate).toHaveBeenCalled();
    const updateArg = subscriptionsUpdate.mock.calls[0][1] as Record<string, unknown>;
    // Must not send both cancel_at and cancel_at_period_end together
    expect(
      Object.prototype.hasOwnProperty.call(updateArg, "cancel_at_period_end") &&
        Object.prototype.hasOwnProperty.call(updateArg, "cancel_at")
    ).toBe(false);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("active without cancel_at_period_end: no charge, already active", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_live",
          status: "active",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(true);
    expect(result.status).toBe("already_active");
    expect(result.charged).toBe(false);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("paused subscription (scheduled pause): reports billing_paused, never creates/charges", async () => {
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14;
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_paused",
          status: "paused",
          cancel_at_period_end: false,
          pause_collection: { behavior: "void", resumes_at: future },
          items: membershipLine("price_legacy", future),
        },
      ],
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(false);
    expect(result.status).toBe("billing_paused");
    expect(result.charged).toBe(false);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(applyTrustedPaymentByMemberstackId).not.toHaveBeenCalled();
    expect(result.message).toContain("resume automatically");
  });

  it("paused subscription (indefinite pause): reports billing_paused", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_paused_indef",
          status: "paused",
          cancel_at_period_end: false,
          pause_collection: { behavior: "void", resumes_at: null },
          items: membershipLine("price_legacy"),
        },
      ],
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(false);
    expect(result.status).toBe("billing_paused");
    expect(result.message).toContain("indefinitely");
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("pause collection with Stripe status still active: reports billing_paused", async () => {
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14;
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_pause_collection",
          status: "active",
          cancel_at_period_end: false,
          pause_collection: { behavior: "keep_as_draft", resumes_at: future },
          items: membershipLine("price_legacy", future),
        },
      ],
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(false);
    expect(result.status).toBe("billing_paused");
    expect(result.message).toContain("resume automatically");
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(applyTrustedPaymentByMemberstackId).not.toHaveBeenCalled();
  });

  it("successful reactivation clears an intro pause (never Excluded)", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_live",
          status: "active",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    findMemberByMemberstackId.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_test",
          [MEMBER_FIELDS.memberstackId]: "mem_1",
          [MEMBER_FIELDS.recurringIntroStatus]: "Paused",
          [MEMBER_FIELDS.recurringPauseUntil]: "2027-01-01",
        },
      },
    ]);

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(true);
    expect(result.status).toBe("already_active");
    const patch = applyTrustedPaymentByMemberstackId.mock.calls[0][0]
      .patch as Record<string, unknown>;
    expect(patch[MEMBER_FIELDS.recurringIntroStatus]).toBe("Active");
    expect(patch[MEMBER_FIELDS.recurringPauseUntil]).toBe("");

    // Excluded members are never auto-resumed by reactivation.
    findMemberByMemberstackId.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_test",
          [MEMBER_FIELDS.memberstackId]: "mem_1",
          [MEMBER_FIELDS.recurringIntroStatus]: "Excluded",
        },
      },
    ]);
    applyTrustedPaymentByMemberstackId.mockClear();
    await reactivateMembershipForMember({ memberstackId: "mem_1" });
    const excludedPatch = applyTrustedPaymentByMemberstackId.mock.calls[0][0]
      .patch as Record<string, unknown>;
    expect(excludedPatch[MEMBER_FIELDS.recurringIntroStatus]).toBeUndefined();
    expect(excludedPatch[MEMBER_FIELDS.recurringPauseUntil]).toBeUndefined();
  });

  it("active old-price member stays on the old price (never migrated)", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_legacy_active",
          status: "active",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("already_active");
    expect(result.charged).toBe(false);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("canceled subscription: creates a new paid subscription at the NEW price", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_old",
          status: "canceled",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      status: "active",
      items: membershipLine("price_new"),
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(true);
    expect(result.status).toBe("reactivated");
    expect(result.charged).toBe(true);
    expect(result.subscriptionId).toBe("sub_new");
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_test",
        items: [{ price: "price_new" }],
        default_payment_method: "pm_card",
        payment_behavior: "error_if_incomplete",
      })
    );
    const patch = applyTrustedPaymentByMemberstackId.mock.calls[0][0]
      .patch as Record<string, unknown>;
    // Native Stripe price_ goes in "Stripe Price ID" — never the Memberstack commerce id.
    expect(patch[MEMBER_FIELDS.stripePriceId]).toBe("price_new");
    expect(patch[MEMBER_FIELDS.memberstackPlanId]).toBe("prc_plan");
  });

  it("uses the billing catalog reactivation price and maps the Memberstack plan id", async () => {
    const prevCatalog = process.env.BILLING_CATALOG_JSON;
    const prevStripeIds = process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
    const prevMsPrice = process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    process.env.STRIPE_REACTIVATION_PRICE_ID = "price_env_stale";
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "";
    delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    process.env.BILLING_CATALOG_JSON = JSON.stringify({
      version: 1,
      defaultTierKey: "standard",
      defaultPriceKey: "standard_quarterly_default",
      prices: [
        {
          priceKey: "standard_quarterly_default",
          tierKey: "standard",
          cadence: "quarterly",
          stripePriceId: "price_catalog_new",
          memberstackPriceId: "prc_catalog_new",
          sellable: true,
          legacy: false,
          eligibleForSignup: true,
          eligibleForReactivation: true,
        },
        {
          priceKey: "standard_legacy",
          tierKey: "standard",
          cadence: "custom",
          stripePriceId: "price_legacy",
          sellable: false,
          legacy: true,
          eligibleForSignup: false,
          eligibleForReactivation: false,
        },
      ],
      offers: [],
    });
    try {
      subscriptionsList.mockResolvedValue({ data: [] });
      subscriptionsCreate.mockResolvedValue({
        id: "sub_catalog",
        status: "active",
        items: membershipLine("price_catalog_new"),
      });

      const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

      expect(result.status).toBe("reactivated");
      const createArgs = subscriptionsCreate.mock.calls[0][0] as {
        items: { price: string }[];
      };
      expect(createArgs.items[0].price).toBe("price_catalog_new");
      expect(createArgs.items[0].price).not.toBe("price_env_stale");
      const patch = applyTrustedPaymentByMemberstackId.mock.calls[0][0]
        .patch as Record<string, unknown>;
      expect(patch[MEMBER_FIELDS.memberstackPlanId]).toBe("prc_catalog_new");
    } finally {
      if (prevCatalog === undefined) delete process.env.BILLING_CATALOG_JSON;
      else process.env.BILLING_CATALOG_JSON = prevCatalog;
      if (prevStripeIds === undefined) delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
      else process.env.STRIPE_MEMBERSHIP_PRICE_IDS = prevStripeIds;
      if (prevMsPrice === undefined) delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
      else process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = prevMsPrice;
    }
  });

  it("canceled after period end never reuses the historical old price", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_ended",
          status: "canceled",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    subscriptionsCreate.mockResolvedValue({
      id: "sub_new2",
      status: "active",
      items: membershipLine("price_new"),
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("reactivated");
    const createArgs = subscriptionsCreate.mock.calls[0][0] as {
      items: { price: string }[];
    };
    expect(createArgs.items[0].price).toBe("price_new");
    expect(createArgs.items[0].price).not.toBe("price_legacy");
  });

  it("prefers cancel reverse over creating a second subscription when both exist", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_canceled",
          status: "canceled",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
        {
          id: "sub_pending",
          status: "active",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_pending",
      status: "active",
      cancel_at_period_end: false,
      items: membershipLine("price_legacy"),
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("cancellation_reversed");
    expect(result.charged).toBe(false);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("canceled with no card on file: no charge, asks for checkout path", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_old",
          status: "canceled",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    customersRetrieve.mockResolvedValue({
      id: "cus_test",
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    paymentMethodsList.mockResolvedValue({ data: [] });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(false);
    expect(result.status).toBe("no_payment_method");
    expect(result.requiresPaymentMethod).toBe(true);
    expect(result.charged).toBe(false);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("trialing + cancel_at_period_end also reverses without charge", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_trial",
          status: "trialing",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_trial",
      status: "trialing",
      cancel_at_period_end: false,
      items: membershipLine("price_legacy"),
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });
    expect(result.status).toBe("cancellation_reversed");
    expect(result.charged).toBe(false);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("past_due subscription with no card: returns no_payment_method", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_past_due",
          status: "past_due",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    customersRetrieve.mockResolvedValue({
      id: "cus_test",
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    paymentMethodsList.mockResolvedValue({ data: [] });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(false);
    expect(result.status).toBe("no_payment_method");
    expect(result.requiresPaymentMethod).toBe(true);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("past_due with card: returns payment_problem, directs to portal", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_past_due",
          status: "past_due",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    customersRetrieve.mockResolvedValue({
      id: "cus_test",
      invoice_settings: { default_payment_method: "pm_card" },
    });
    paymentMethodsList.mockResolvedValue({ data: [{ id: "pm_card" }] });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(false);
    expect(result.status).toBe("payment_problem");
    expect(result.requiresPaymentMethod).toBe(true);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("cancellation_reversed includes nextRenewalDate", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_cancel_sched",
          status: "active",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy", 1735689600),
          current_period_end: 1735689600,
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_cancel_sched",
      status: "active",
      cancel_at_period_end: false,
      items: membershipLine("price_legacy", 1735689600),
      current_period_end: 1735689600,
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("cancellation_reversed");
    expect(result.nextRenewalDate).toBe("2025-01-01");
    expect(result.currentPeriodEnd).toBe("2025-01-01");
  });

  it("result includes message for widgetApi consumers", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_cancel_sched2",
          status: "active",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy", 1735689600),
          current_period_end: 1735689600,
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_cancel_sched2",
      status: "active",
      cancel_at_period_end: false,
      items: membershipLine("price_legacy", 1735689600),
      current_period_end: 1735689600,
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.message).toBeTruthy();
    expect(result.message).toBe(result.reason);
    expect(result.message).toContain("not be charged today");
  });

  it("no_payment_method includes message for widgetApi consumers", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_old",
          status: "canceled",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    customersRetrieve.mockResolvedValue({
      id: "cus_test",
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    paymentMethodsList.mockResolvedValue({ data: [] });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
    expect(result.message).toBe(result.reason);
  });

  // —— Grandfathering / full-refund rules ——

  it("full refund + rejoin before old period end: rejoins at NEW price, does not reverse", async () => {
    findMemberByMemberstackId.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_test",
          [MEMBER_FIELDS.memberstackId]: "mem_1",
          [MEMBER_FIELDS.payment]: "Refunded",
        },
      },
    ]);
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_refunded_pending",
          status: "active",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy", 1735689600),
          current_period_end: 1735689600,
        },
      ],
    });
    subscriptionsCancel.mockResolvedValue({ id: "sub_refunded_pending", status: "canceled" });
    subscriptionsCreate.mockResolvedValue({
      id: "sub_new_refund",
      status: "active",
      items: membershipLine("price_new"),
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("reactivated");
    expect(result.charged).toBe(true);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_refunded_pending");
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ price: "price_new" }] })
    );
  });

  it("full refund (Stripe-strengthened) also blocks old-price recovery", async () => {
    // Airtable does NOT say Refunded, but Stripe's latest qualifying payment is a full refund.
    calculateStripeEntitlement.mockResolvedValue({
      qualifyingPayments: [
        { periodEndUnix: 1735689600, refundKind: "full", invoiceId: "in_x" },
      ],
    });
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_refunded_stripe",
          status: "active",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy", 1735689600),
          current_period_end: 1735689600,
        },
      ],
    });
    subscriptionsCancel.mockResolvedValue({ id: "sub_refunded_stripe", status: "canceled" });
    subscriptionsCreate.mockResolvedValue({
      id: "sub_new_stripe",
      status: "active",
      items: membershipLine("price_new"),
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("reactivated");
    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_refunded_stripe");
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ price: "price_new" }] })
    );
  });

  it("partial refund does not remove grandfathering — reverses old subscription", async () => {
    calculateStripeEntitlement.mockResolvedValue({
      qualifyingPayments: [
        { periodEndUnix: 1735689600, refundKind: "partial", invoiceId: "in_y" },
      ],
    });
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_partial_refund",
          status: "active",
          cancel_at_period_end: true,
          items: membershipLine("price_legacy", 1735689600),
          current_period_end: 1735689600,
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_partial_refund",
      status: "active",
      cancel_at_period_end: false,
      items: membershipLine("price_legacy", 1735689600),
      current_period_end: 1735689600,
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("cancellation_reversed");
    expect(result.charged).toBe(false);
    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_partial_refund", {
      cancel_at_period_end: false,
    });
  });

  it("full refund with a still-active old subscription ends it before creating new (no duplicates)", async () => {
    findMemberByMemberstackId.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          [MEMBER_FIELDS.stripeCustomerId]: "cus_test",
          [MEMBER_FIELDS.memberstackId]: "mem_1",
          [MEMBER_FIELDS.payment]: "Refunded",
        },
      },
    ]);
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_still_active",
          status: "active",
          cancel_at_period_end: false,
          items: membershipLine("price_legacy"),
        },
      ],
    });
    subscriptionsCancel.mockResolvedValue({ id: "sub_still_active", status: "canceled" });
    subscriptionsCreate.mockResolvedValue({
      id: "sub_new_after_refund",
      status: "active",
      items: membershipLine("price_new"),
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.status).toBe("reactivated");
    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_still_active");
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ price: "price_new" }] })
    );
    // Old subscription was ended, never reversed to active
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });
});
