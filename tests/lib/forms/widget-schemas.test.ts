import { describe, it, expect } from "vitest";
import {
  accountFormSchema,
  businessFormSchema,
  locationFormSchema,
} from "../../../widgets/shared/widget-schemas";

describe("widget schemas", () => {
  it("validates account and lowercases email", () => {
    const r = accountFormSchema.parse({
      firstName: "Ada",
      lastName: "Lovelace",
      email: " Ada@WLTH.COM ",
      password: "password1",
    });
    expect(r.email).toBe("ada@wlth.com");
  });

  it("rejects short password", () => {
    expect(
      accountFormSchema.safeParse({
        firstName: "A",
        lastName: "B",
        email: "a@b.com",
        password: "short",
      }).success
    ).toBe(false);
  });

  it("requires availability", () => {
    expect(
      locationFormSchema.safeParse({
        countryCode: "GB",
        cityCode: "GB-LON",
        availability: [],
      }).success
    ).toBe(false);
  });

  it("requires business description length", () => {
    expect(
      businessFormSchema.safeParse({
        primaryIndustry: "TECH_SAAS",
        businessStage: "EARLY_TRACTION",
        annualRevenue: "10K_50K",
        businessDescription: "too short",
      }).success
    ).toBe(false);
  });
});
