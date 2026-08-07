import { beforeEach, describe, expect, it, vi } from "vitest";

const findMemberByMemberstackId = vi.fn();
const applyTrustedPaymentByMemberstackId = vi.fn();
const subscriptionsList = vi.fn();
const subscriptionsUpdate = vi.fn();
const subscriptionsCreate = vi.fn();
const customersRetrieve = vi.fn();
const customersUpdate = vi.fn();
const paymentMethodsList = vi.fn();
const pricesList = vi.fn();

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  findMemberByMemberstackId: (...a: unknown[]) => findMemberByMemberstackId(...a),
  applyTrustedPaymentByMemberstackId: (...a: unknown[]) =>
    applyTrustedPaymentByMemberstackId(...a),
}));

vi.mock("@/lib/integrations/stripe", () => ({
  getStripeClient: () => ({
    subscriptions: {
      list: (...a: unknown[]) => subscriptionsList(...a),
      update: (...a: unknown[]) => subscriptionsUpdate(...a),
      create: (...a: unknown[]) => subscriptionsCreate(...a),
    },
    customers: {
      retrieve: (...a: unknown[]) => customersRetrieve(...a),
      update: (...a: unknown[]) => customersUpdate(...a),
    },
    paymentMethods: {
      list: (...a: unknown[]) => paymentMethodsList(...a),
    },
    prices: {
      list: (...a: unknown[]) => pricesList(...a),
    },
  }),
  getConfiguredMembershipPriceIds: () => new Set(["price_membership"]),
  getConfiguredMemberstackPlanId: () => "prc_plan",
}));

vi.mock("@/lib/billing/service-access-sync", () => ({
  formatPaidPlansText: (ids: string[]) => ids.filter(Boolean).join(", "),
}));

import { reactivateMembershipForMember } from "@/lib/forms/billing/reactivate-membership";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

describe("reactivateMembershipForMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    pricesList.mockResolvedValue({ data: [{ id: "price_membership", unit_amount: 4500 }] });
    customersRetrieve.mockResolvedValue({
      id: "cus_test",
      invoice_settings: { default_payment_method: "pm_card" },
    });
    paymentMethodsList.mockResolvedValue({ data: [{ id: "pm_card" }] });
    customersUpdate.mockResolvedValue({});
  });

  it("active + cancel_at_period_end: reverses cancel only — no create/checkout charge", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_pending",
          status: "active",
          cancel_at_period_end: true,
          items: { data: [{ price: { id: "price_membership" } }] },
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_pending",
      status: "active",
      cancel_at_period_end: false,
      items: { data: [{ price: { id: "price_membership" } }] },
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });

    expect(result.success).toBe(true);
    expect(result.status).toBe("cancellation_reversed");
    expect(result.charged).toBe(false);
    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_pending", {
      cancel_at_period_end: false,
    });
    expect(subscriptionsCreate).not.toHaveBeenCalled();
    expect(applyTrustedPaymentByMemberstackId).toHaveBeenCalled();
  });

  it("active without cancel_at_period_end: no charge, already active", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_live",
          status: "active",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_membership" } }] },
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

  it("canceled subscription: creates a new paid subscription (charge path)", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_old",
          status: "canceled",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_membership" } }] },
        },
      ],
    });
    subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      status: "active",
      items: { data: [{ price: { id: "price_membership" } }] },
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
        items: [{ price: "price_membership" }],
        default_payment_method: "pm_card",
        payment_behavior: "error_if_incomplete",
      })
    );
  });

  it("prefers cancel reverse over creating a second subscription when both exist", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        {
          id: "sub_canceled",
          status: "canceled",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_membership" } }] },
        },
        {
          id: "sub_pending",
          status: "active",
          cancel_at_period_end: true,
          items: { data: [{ price: { id: "price_membership" } }] },
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_pending",
      status: "active",
      cancel_at_period_end: false,
      items: { data: [{ price: { id: "price_membership" } }] },
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
          items: { data: [{ price: { id: "price_membership" } }] },
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
          items: { data: [{ price: { id: "price_membership" } }] },
        },
      ],
    });
    subscriptionsUpdate.mockResolvedValue({
      id: "sub_trial",
      status: "trialing",
      cancel_at_period_end: false,
      items: { data: [{ price: { id: "price_membership" } }] },
    });

    const result = await reactivateMembershipForMember({ memberstackId: "mem_1" });
    expect(result.status).toBe("cancellation_reversed");
    expect(result.charged).toBe(false);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });
});
