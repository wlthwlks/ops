import { describe, it, expect } from "vitest";
import {
  accountSchema,
  locationSchema,
  businessSchema,
  goalSchema,
  bootstrapSchema,
} from "@/lib/forms/schemas/onboarding";

const COUNTRY_ID = "reccnnjiVkL28NBgV";
const CITY_ID = "rec8cL36vOg1PpgIY";

describe("onboarding schemas", () => {
  it("normalizes email to lowercase", () => {
    const r = accountSchema.parse({
      firstName: "Ada",
      lastName: "Lovelace",
      age: "25-34",
      email: "  Ada@Ex.COM ",
    });
    expect(r.email).toBe("ada@ex.com");
  });

  it("rejects account without age", () => {
    const r = accountSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "a@b.com",
    });
    expect(r.success).toBe(false);
  });

  it("accepts all five age ranges on bootstrap", () => {
    for (const age of ["18-24", "25-34", "35-44", "45-54", "55+"] as const) {
      const r = bootstrapSchema.safeParse({
        firstName: "A",
        lastName: "B",
        age,
        email: "a@b.com",
      });
      expect(r.success).toBe(true);
    }
  });

  it("bootstrap rejects invalid age", () => {
    expect(
      bootstrapSchema.safeParse({
        firstName: "A",
        lastName: "B",
        age: "invalid",
        email: "a@b.com",
      }).success
    ).toBe(false);
  });

  it("accepts coaching industry", () => {
    const ok = businessSchema.safeParse({
      primaryIndustry: "COACHING",
      businessStage: "EARLY_TRACTION",
      annualRevenue: "10K_50K",
      businessDescription:
        "We help independent founders grow through peer community and introductions in major cities worldwide.",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects non-Airtable city/country ids", () => {
    const r = locationSchema.safeParse({
      countryCode: "GB",
      cityCode: "GB-LON",
      phone: "211234567",
      phonePrefix: "+64",
    });
    expect(r.success).toBe(false);
  });

  it("accepts valid location with phone and optional post code", () => {
    const r = locationSchema.parse({
      countryCode: COUNTRY_ID,
      cityCode: CITY_ID,
      phone: "211234567",
      phonePrefix: "+64",
      postCode: "EC1V 9HX",
    });
    expect(r.cityCode).toBe(CITY_ID);
    expect(r.countryCode).toBe(COUNTRY_ID);
    expect(r.phonePrefix).toBe("+64");
    expect(r.postCode).toBe("EC1V 9HX");
  });

  it("accepts location with availability when supplied (backward compat)", () => {
    const r = locationSchema.safeParse({
      countryCode: COUNTRY_ID,
      cityCode: CITY_ID,
      phone: "211234567",
      phonePrefix: "+64",
      availability: ["mon_morning", "tue_evening"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects location without phone", () => {
    const r = locationSchema.safeParse({
      countryCode: COUNTRY_ID,
      cityCode: CITY_ID,
    });
    expect(r.success).toBe(false);
  });

  it("accepts location without availability", () => {
    // Availability is no longer mandatory
    const r = locationSchema.safeParse({
      countryCode: COUNTRY_ID,
      cityCode: CITY_ID,
      phone: "211234567",
      phonePrefix: "+64",
    });
    expect(r.success).toBe(true);
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

  it("returns friendly goal length messages", () => {
    const short = goalSchema.safeParse({ ninetyDayGoal: "short" });
    expect(short.error?.issues[0]?.message).toBe("Please write at least 30 characters");

    const long = goalSchema.safeParse({ ninetyDayGoal: "x".repeat(501) });
    expect(long.error?.issues[0]?.message).toBe("Keep under 500 characters");
  });
});
