import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  updateMemberBilling: vi.fn(async () => ({ record: null, status: "STRIPE_MEMBER_NOT_FOUND" })),
}));

vi.mock("@/lib/forms/webhooks/store", () => ({
  recordIntegrationError: vi.fn(async () => "e1"),
}));

describe("handleExpandedStripeEvent", () => {
  const prev = process.env.NEW_STRIPE_WEBHOOKS_ENABLED;
  const shadow = process.env.MAKE_SHADOW_MODE;

  beforeEach(() => {
    process.env.NEW_STRIPE_WEBHOOKS_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "false";
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
    const { handleExpandedStripeEvent } = await import(
      "@/lib/forms/webhooks/stripe-lifecycle"
    );
    const { recordIntegrationError } = await import("@/lib/forms/webhooks/store");
    const { updateMemberBilling } = await import("@/lib/forms/airtable/members-sync");
    const r = await handleExpandedStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: { customer: "cus_missing", subscription: "sub_1", id: "cs_1" },
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
});
