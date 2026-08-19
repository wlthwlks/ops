import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const updateMemberBilling = vi.fn();
const recordIntegrationError = vi.fn();

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  updateMemberBilling: (...a: unknown[]) => updateMemberBilling(...a),
}));

vi.mock("@/lib/forms/webhooks/store", () => ({
  recordIntegrationError: (...a: unknown[]) => recordIntegrationError(...a),
}));

describe("handleExpandedStripeEvent", () => {
  const prev = process.env.NEW_STRIPE_WEBHOOKS_ENABLED;
  const shadow = process.env.MAKE_SHADOW_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEW_STRIPE_WEBHOOKS_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "false";
    updateMemberBilling.mockResolvedValue({
      record: { id: "rec1", fields: {} },
      status: "updated",
    });
    recordIntegrationError.mockResolvedValue("e1");
    vi.resetModules();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.NEW_STRIPE_WEBHOOKS_ENABLED;
    else process.env.NEW_STRIPE_WEBHOOKS_ENABLED = prev;
    if (shadow === undefined) delete process.env.MAKE_SHADOW_MODE;
    else process.env.MAKE_SHADOW_MODE = shadow;
  });

  it("ignores when flag off", async () => {
    process.env.NEW_STRIPE_WEBHOOKS_ENABLED = "false";
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const r = await handleExpandedStripeEvent({
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_x", id: "sub_x" } },
    } as never);
    expect(r.status).toMatch(/ignored/i);
  });

  it("records STRIPE_MEMBER_NOT_FOUND without creating members", async () => {
    updateMemberBilling.mockResolvedValue({
      record: null,
      status: "STRIPE_MEMBER_NOT_FOUND",
    });
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const r = await handleExpandedStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_missing",
          subscription: "sub_1",
          id: "cs_1",
          payment_status: "paid",
        },
      },
    } as never);
    expect(updateMemberBilling).toHaveBeenCalled();
    expect(r.status).toBe("pending_dependency");
    expect(recordIntegrationError).toHaveBeenCalled();
  });

  it("logs refund for manual review", async () => {
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const r = await handleExpandedStripeEvent({
      type: "charge.refunded",
      data: { object: { id: "ch_1", customer: "cus_1" } },
    } as never);
    expect(r.status).toBe("manual_review");
  });

  it("scheduled-cancel subscription.updated does not write Service access until", async () => {
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    await handleExpandedStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_sched",
          customer: "cus_x",
          status: "active",
          cancel_at_period_end: true,
          cancel_at: future,
          current_period_end: future,
          items: { data: [{ current_period_end: future }] },
        },
      },
    } as never);

    const patch = updateMemberBilling.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch["Cancel at period end"]).toBe("true");
    expect(patch["Cancellation effective at"]).toBeTruthy();
    expect(patch["Membership"]).toBeUndefined();
    expect(patch["Payment"]).toBeUndefined();
    expect(patch["Service access until"]).toBeUndefined();
  });

  it("active subscription.created never claims Paid/Active — only cancels flags + ids", async () => {
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    await handleExpandedStripeEvent({
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_new",
          customer: "cus_x",
          status: "active",
          cancel_at_period_end: false,
          current_period_end: future,
          items: {
            data: [
              {
                current_period_end: future,
                price: { id: "price_mem" },
              },
            ],
          },
        },
      },
    } as never);

    const patch = updateMemberBilling.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch["Cancel at period end"]).toBe("false");
    expect(patch["Cancellation effective at"]).toBe("");
    expect(patch["Stripe Price ID"]).toBe("price_mem");
    expect(patch["Stripe subscription status"]).toBe("active");
    expect(patch["Payment"]).toBeUndefined();
    expect(patch["Membership"]).toBeUndefined();
    expect(patch["Service access until"]).toBeUndefined();
  });

  it("pre-checkout subscription.updated on an active sub never re-marks Paid/Active/access", async () => {
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    await handleExpandedStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_active",
          customer: "cus_x",
          status: "active",
          cancel_at_period_end: false,
          current_period_end: future,
          items: {
            data: [{ current_period_end: future, price: { id: "price_mem" } }],
          },
        },
      },
    } as never);

    const patch = updateMemberBilling.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch["Cancel at period end"]).toBe("false");
    expect(patch["Stripe Price ID"]).toBe("price_mem");
    expect(patch["Payment"]).toBeUndefined();
    expect(patch["Membership"]).toBeUndefined();
    expect(patch["Service access until"]).toBeUndefined();
  });

  it("checkout.session.completed with unpaid payment does NOT mark Paid/Active", async () => {
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const r = await handleExpandedStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_unpaid",
          customer: "cus_x",
          subscription: "sub_unpaid",
          payment_status: "unpaid",
        },
      },
    } as never);

    expect(r.status).toBe("ignored_unpaid");
    const patch = updateMemberBilling.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch["Payment"]).toBeUndefined();
    expect(patch["Membership"]).toBeUndefined();
    expect(patch["Cancel at period end"]).toBeUndefined();
    expect(patch["Stripe Customer ID"]).toBe("cus_x");
    expect(patch["Stripe Subscription ID"]).toBe("sub_unpaid");
  });

  it("checkout.session.completed with paid payment still marks Paid/Active", async () => {
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const r = await handleExpandedStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_paid",
          customer: "cus_x",
          subscription: "sub_paid",
          payment_status: "paid",
        },
      },
    } as never);

    expect(r.status).toBe("updated");
    const patch = updateMemberBilling.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch["Payment"]).toBe("Paid");
    expect(patch["Membership"]).toBe("Active");
    expect(patch["Cancel at period end"]).toBe(false);
    expect(patch["Service access until"]).toBeUndefined();
  });
});
