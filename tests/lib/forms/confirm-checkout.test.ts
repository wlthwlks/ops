import { describe, it, expect } from "vitest";
import { extractStripeCustomerIdFromMemberstackRaw } from "@/lib/forms/billing/confirm-checkout";

describe("extractStripeCustomerIdFromMemberstackRaw", () => {
  it("reads stripeCustomerId", () => {
    expect(
      extractStripeCustomerIdFromMemberstackRaw({ stripeCustomerId: "cus_abc123" })
    ).toBe("cus_abc123");
  });

  it("reads nested stripe.customerId", () => {
    expect(
      extractStripeCustomerIdFromMemberstackRaw({
        stripe: { customerId: "cus_nested" },
      })
    ).toBe("cus_nested");
  });

  it("returns empty when missing", () => {
    expect(extractStripeCustomerIdFromMemberstackRaw({})).toBe("");
    expect(extractStripeCustomerIdFromMemberstackRaw({ stripeCustomerId: "bad" })).toBe(
      ""
    );
  });
});
