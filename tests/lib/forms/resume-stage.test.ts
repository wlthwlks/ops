import { describe, it, expect } from "vitest";
import {
  mapResumeStage,
  isExplicitInProgressOnboarding,
} from "@/app/api/onboarding/status/route";

describe("isExplicitInProgressOnboarding", () => {
  it("blank and COMPLETE are not mid-signup (legacy / established)", () => {
    expect(isExplicitInProgressOnboarding("")).toBe(false);
    expect(isExplicitInProgressOnboarding(null)).toBe(false);
    expect(isExplicitInProgressOnboarding("COMPLETE")).toBe(false);
  });

  it("cancelled billing must not matter — only status does", () => {
    expect(isExplicitInProgressOnboarding("PAYMENT_PENDING")).toBe(true);
    expect(isExplicitInProgressOnboarding("GOAL")).toBe(true);
    expect(isExplicitInProgressOnboarding("COMPLETE")).toBe(false);
  });
});

describe("mapResumeStage — next step after last completed", () => {
  it("ACCOUNT_CREATED → Location (not Payment)", () => {
    expect(mapResumeStage("ACCOUNT_CREATED", false)).toBe("LOCATION");
  });

  it("LOCATION completed → Business", () => {
    expect(mapResumeStage("LOCATION", false)).toBe("BUSINESS");
  });

  it("BUSINESS completed → Payment when unpaid", () => {
    expect(mapResumeStage("BUSINESS", false)).toBe("PAYMENT_PENDING");
  });

  it("BUSINESS completed + paid → Matching (GOAL)", () => {
    expect(mapResumeStage("BUSINESS", true)).toBe("GOAL");
  });

  it("PAYMENT_PENDING unpaid stays on payment", () => {
    expect(mapResumeStage("PAYMENT_PENDING", false)).toBe("PAYMENT_PENDING");
  });

  it("PAYMENT_PENDING paid → GOAL", () => {
    expect(mapResumeStage("PAYMENT_PENDING", true)).toBe("GOAL");
  });

  it("GOAL completed → HELP_WANTED", () => {
    expect(mapResumeStage("GOAL", false)).toBe("HELP_WANTED");
  });

  it("never jumps Location straight to Payment", () => {
    expect(mapResumeStage("ACCOUNT_CREATED", false)).not.toBe("PAYMENT_PENDING");
    expect(mapResumeStage("LOCATION", false)).not.toBe("PAYMENT_PENDING");
  });
});
