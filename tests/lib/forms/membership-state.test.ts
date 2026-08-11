import { describe, it, expect } from "vitest";
import {
  classifyMembershipUiState,
  hasRemainingServiceAccess,
  formatMembershipAccessDate,
} from "@/lib/forms/billing/membership-state";
import type { MembershipStateInput } from "@/lib/forms/billing/membership-state";

const now = new Date("2026-08-11");

describe("classifyMembershipUiState", () => {
  it("active + cancel_at_period_end=true → cancellation_scheduled", () => {
    const result = classifyMembershipUiState({
      stripeSubscriptionStatus: "active",
      cancelAtPeriodEnd: true,
      serviceAccessUntil: "2026-11-01",
      membership: "Active",
      payment: "Paid",
      now,
    });
    expect(result).toBe("cancellation_scheduled");
  });

  it("active + cancel_at_period_end=false → active", () => {
    const result = classifyMembershipUiState({
      stripeSubscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      serviceAccessUntil: "2026-11-01",
      membership: "Active",
      payment: "Paid",
      now,
    });
    expect(result).toBe("active");
  });

  it("past_due → payment_problem", () => {
    const result = classifyMembershipUiState({
      stripeSubscriptionStatus: "past_due",
      cancelAtPeriodEnd: false,
      membership: "Active",
      payment: "Paid",
      now,
    });
    expect(result).toBe("payment_problem");
  });

  it("unpaid → payment_problem", () => {
    const result = classifyMembershipUiState({
      stripeSubscriptionStatus: "unpaid",
      cancelAtPeriodEnd: false,
      membership: "Active",
      payment: "Paid",
      now,
    });
    expect(result).toBe("payment_problem");
  });

  it("canceled + access until future → cancellation_scheduled", () => {
    const result = classifyMembershipUiState({
      stripeSubscriptionStatus: "canceled",
      membership: "Cancelled",
      payment: "Paid",
      serviceAccessUntil: "2026-11-01",
      cancelAtPeriodEnd: false,
      now,
    });
    expect(result).toBe("cancellation_scheduled");
  });

  it("canceled + access until past → expired", () => {
    const result = classifyMembershipUiState({
      stripeSubscriptionStatus: "canceled",
      membership: "Cancelled",
      payment: "Paid",
      serviceAccessUntil: "2026-01-01",
      cancelAtPeriodEnd: false,
      now,
    });
    expect(result).toBe("expired");
  });

  it("Airtable only: Active+Paid+no cancel → active", () => {
    const result = classifyMembershipUiState({
      membership: "Active",
      payment: "Paid",
      cancelAtPeriodEnd: false,
      now,
    });
    expect(result).toBe("active");
  });

  it("Airtable only: Active+Paid+cancelAtPeriodEnd → cancellation_scheduled", () => {
    const result = classifyMembershipUiState({
      membership: "Active",
      payment: "Paid",
      cancelAtPeriodEnd: true,
      serviceAccessUntil: "2026-11-01",
      now,
    });
    expect(result).toBe("cancellation_scheduled");
  });

  it("failed payment → payment_problem", () => {
    const result = classifyMembershipUiState({
      membership: "Active",
      payment: "Failed",
      cancelAtPeriodEnd: false,
      now,
    });
    expect(result).toBe("payment_problem");
  });

  it("pending payment → incomplete_onboarding", () => {
    const result = classifyMembershipUiState({
      membership: "Pending Payment",
      payment: "Pending",
      cancelAtPeriodEnd: false,
      now,
    });
    expect(result).toBe("incomplete_onboarding");
  });
});

describe("hasRemainingServiceAccess", () => {
  it("future date → true", () => {
    expect(hasRemainingServiceAccess("2026-11-01", new Date("2026-08-11"))).toBe(true);
  });

  it("past date → false", () => {
    expect(hasRemainingServiceAccess("2026-01-01", new Date("2026-08-11"))).toBe(false);
  });

  it("same day → true", () => {
    expect(hasRemainingServiceAccess("2026-08-11", new Date("2026-08-11"))).toBe(true);
  });

  it("null → false", () => {
    expect(hasRemainingServiceAccess(null)).toBe(false);
  });

  it("empty string → false", () => {
    expect(hasRemainingServiceAccess("")).toBe(false);
  });
});

describe("formatMembershipAccessDate", () => {
  it("formats ISO string to YYYY-MM-DD", () => {
    expect(formatMembershipAccessDate("2026-11-01T00:00:00.000Z")).toBe("2026-11-01");
  });

  it("returns empty for empty input", () => {
    expect(formatMembershipAccessDate("")).toBe("");
    expect(formatMembershipAccessDate(null)).toBe("");
  });
});
