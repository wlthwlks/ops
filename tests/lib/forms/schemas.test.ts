import { describe, it, expect } from "vitest";
import {
  accountSchema,
  locationSchema,
  businessSchema,
  goalSchema,
} from "@/lib/forms/schemas/onboarding";

describe("onboarding schemas", () => {
  it("normalizes email to lowercase", () => {
    const r = accountSchema.parse({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "  Ada@Ex.COM ",
    });
    expect(r.email).toBe("ada@ex.com");
  });

  it("rejects city/country mismatch", () => {
    const r = locationSchema.safeParse({
      countryCode: "US",
      cityCode: "GB-LON",
      availability: ["mon_morning"],
    });
    expect(r.success).toBe(false);
  });

  it("accepts valid location", () => {
    const r = locationSchema.parse({
      countryCode: "GB",
      cityCode: "GB-LON",
      availability: ["mon_morning", "tue_evening"],
    });
    expect(r.cityCode).toBe("GB-LON");
  });

  it("enforces business description length", () => {
    const short = businessSchema.safeParse({
      primaryIndustry: "TECH_SAAS",
      businessStage: "EARLY_TRACTION",
      annualRevenue: "10K_50K",
      businessDescription: "too short",
    });
    expect(short.success).toBe(false);

    const ok = businessSchema.safeParse({
      primaryIndustry: "TECH_SAAS",
      businessStage: "EARLY_TRACTION",
      annualRevenue: "10K_50K",
      businessDescription:
        "We help independent founders grow through peer community and introductions in major cities worldwide.",
    });
    expect(ok.success).toBe(true);
  });

  it("enforces goal length", () => {
    expect(goalSchema.safeParse({ ninetyDayGoal: "short" }).success).toBe(false);
    expect(
      goalSchema.safeParse({
        ninetyDayGoal:
          "Ship the new onboarding flow and validate conversion against Tally baseline this quarter.",
      }).success
    ).toBe(true);
  });
});
