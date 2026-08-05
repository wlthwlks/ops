import { describe, it, expect } from "vitest";
import { mapResumeStage } from "@/app/api/onboarding/status/route";

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
