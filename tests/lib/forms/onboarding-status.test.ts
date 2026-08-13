import { describe, it, expect } from "vitest";
import {
  isEstablishedOnboarding,
  isInProgressOnboarding,
} from "@/lib/forms/onboarding/onboarding-status";

describe("isEstablishedOnboarding", () => {
  it("blank → established (legacy member)", () => {
    expect(isEstablishedOnboarding("")).toBe(true);
    expect(isEstablishedOnboarding(null)).toBe(true);
    expect(isEstablishedOnboarding(undefined)).toBe(true);
    expect(isEstablishedOnboarding("   ")).toBe(true);
  });

  it("COMPLETE (any case) → established", () => {
    expect(isEstablishedOnboarding("COMPLETE")).toBe(true);
    expect(isEstablishedOnboarding("complete")).toBe(true);
    expect(isEstablishedOnboarding("Complete")).toBe(true);
  });

  it("COMPLETED variant → established", () => {
    expect(isEstablishedOnboarding("COMPLETED")).toBe(true);
    expect(isEstablishedOnboarding("completed")).toBe(true);
  });

  it("in-progress stages → not established", () => {
    expect(isEstablishedOnboarding("PAYMENT_PENDING")).toBe(false);
    expect(isEstablishedOnboarding("PAYMENT_CONFIRMED")).toBe(false);
    expect(isEstablishedOnboarding("ACCOUNT_CREATED")).toBe(false);
    expect(isEstablishedOnboarding("BUSINESS")).toBe(false);
    expect(isEstablishedOnboarding("GOAL")).toBe(false);
  });
});

describe("isInProgressOnboarding", () => {
  it("in-progress stages → true", () => {
    expect(isInProgressOnboarding("PAYMENT_PENDING")).toBe(true);
    expect(isInProgressOnboarding("BUSINESS")).toBe(true);
  });

  it("blank / COMPLETE → false", () => {
    expect(isInProgressOnboarding("")).toBe(false);
    expect(isInProgressOnboarding("COMPLETE")).toBe(false);
    expect(isInProgressOnboarding("COMPLETED")).toBe(false);
  });
});
