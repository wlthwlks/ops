import { describe, it, expect } from "vitest";
import {
  extractStripeCustomerIdFromMemberstackRaw,
  isRecentStripeTimestamp,
} from "@/lib/forms/billing/confirm-checkout";

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

describe("isRecentStripeTimestamp", () => {
  const now = 1_800_000_000;

  it("accepts timestamps within the 15-minute window", () => {
    expect(isRecentStripeTimestamp(now, now)).toBe(true);
    expect(isRecentStripeTimestamp(now - 10 * 60, now)).toBe(true);
  });

  it("rejects timestamps older than the window", () => {
    expect(isRecentStripeTimestamp(now - 20 * 60, now)).toBe(false);
    expect(isRecentStripeTimestamp(now - 60 * 60, now)).toBe(false);
    expect(isRecentStripeTimestamp(now - 3 * 60 * 60, now)).toBe(false);
    expect(isRecentStripeTimestamp(now - 7 * 24 * 60 * 60, now)).toBe(false);
  });

  it("rejects missing/zero timestamps", () => {
    expect(isRecentStripeTimestamp(null, now)).toBe(false);
    expect(isRecentStripeTimestamp(undefined, now)).toBe(false);
    expect(isRecentStripeTimestamp(0, now)).toBe(false);
  });
});
