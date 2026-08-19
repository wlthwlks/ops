import { describe, it, expect } from "vitest";
import {
  accountFormSchema,
  businessFormSchema,
  locationFormSchema,
  helpFormSchema,
  expertiseFormSchema,
  AGE_RANGES,
} from "../../../widgets/shared/widget-schemas";

const COUNTRY_ID = "reccnnjiVkL28NBgV";
const CITY_ID = "rec8cL36vOg1PpgIY";

describe("widget schemas", () => {
  it("validates account and lowercases email (no phone)", () => {
    const r = accountFormSchema.parse({
      firstName: "Ada",
      lastName: "Lovelace",
      age: "25-34",
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
        age: "18-24",
        email: "a@b.com",
        password: "short",
      }).success
    ).toBe(false);
  });

  it("requires age in account form", () => {
    expect(
      accountFormSchema.safeParse({
        firstName: "Ada",
        lastName: "Lovelace",
        age: "",
        email: "a@b.com",
        password: "password1",
      }).success
    ).toBe(false);
  });

  it("accepts all five age ranges", () => {
    for (const age of AGE_RANGES) {
      const r = accountFormSchema.safeParse({
        firstName: "A",
        lastName: "B",
        age,
        email: "a@b.com",
        password: "password1",
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects arbitrary age values", () => {
    expect(
      accountFormSchema.safeParse({
        firstName: "A",
        lastName: "B",
        age: "under-18",
        email: "a@b.com",
        password: "password1",
      }).success
    ).toBe(false);
  });

  it("requires valid phone on location", () => {
    expect(
      locationFormSchema.safeParse({
        countryCode: COUNTRY_ID,
        cityCode: CITY_ID,
        phone: "12",
        phonePrefix: "+64",
        availability: ["mon_morning"],
      }).success
    ).toBe(false);

    const ok = locationFormSchema.safeParse({
      countryCode: COUNTRY_ID,
      cityCode: CITY_ID,
      phone: "211234567",
      phonePrefix: "+64",
      postCode: "1010",
      availability: ["mon_morning"],
    });
    expect(ok.success).toBe(true);
  });

  it("requires other industry text when OTHER selected", () => {
    expect(
      businessFormSchema.safeParse({
        primaryIndustry: "OTHER",
        businessStage: "EARLY_TRACTION",
        annualRevenue: "10K_50K",
        businessDescription:
          "We help independent founders grow through peer community and introductions in major cities worldwide.",
        otherIndustry: "",
        socialLinks: [{ platform: "linkedin", url: "https://linkedin.com/in/test" }],
      }).success
    ).toBe(false);
  });

  it("requires availability (now optional — no longer required)", () => {
    // Availability is no longer required; location form succeeds without it.
    const r = locationFormSchema.safeParse({
      countryCode: COUNTRY_ID,
      cityCode: CITY_ID,
      phone: "211234567",
      phonePrefix: "+64",
      availability: [],
    });
    expect(r.success).toBe(true);
  });

  it("requires business description length", () => {
    expect(
      businessFormSchema.safeParse({
        primaryIndustry: "TECH_SAAS",
        businessStage: "EARLY_TRACTION",
        annualRevenue: "10K_50K",
        businessDescription: "too short",
        socialLinks: [{ platform: "linkedin", url: "https://linkedin.com/in/test" }],
      }).success
    ).toBe(false);
  });

  it("requires at least one social profile on the business form", () => {
    expect(
      businessFormSchema.safeParse({
        primaryIndustry: "TECH_SAAS",
        businessStage: "EARLY_TRACTION",
        annualRevenue: "10K_50K",
        businessDescription:
          "We help independent founders grow through peer community and introductions in major cities worldwide.",
        socialLinks: [],
      }).success
    ).toBe(false);

    const ok = businessFormSchema.safeParse({
      primaryIndustry: "TECH_SAAS",
      businessStage: "EARLY_TRACTION",
      annualRevenue: "10K_50K",
      businessDescription:
        "We help independent founders grow through peer community and introductions in major cities worldwide.",
      socialLinks: [{ platform: "instagram", url: "https://instagram.com/test" }],
    });
    expect(ok.success).toBe(true);
  });

  it("requires at least one help area", () => {
    expect(helpFormSchema.safeParse({ helpWanted: [] }).success).toBe(false);
    expect(helpFormSchema.safeParse({ helpWanted: ["INTROS"] }).success).toBe(true);
  });

  it("requires at least one expertise area", () => {
    expect(expertiseFormSchema.safeParse({ expertiseOffered: [] }).success).toBe(false);
    expect(expertiseFormSchema.safeParse({ expertiseOffered: ["SALES"] }).success).toBe(true);
  });
});
