import { describe, it, expect } from "vitest";
import {
  accountFormSchema,
  businessFormSchema,
  locationFormSchema,
} from "../../../widgets/shared/widget-schemas";

const COUNTRY_ID = "reccnnjiVkL28NBgV";
const CITY_ID = "rec8cL36vOg1PpgIY";

describe("widget schemas", () => {
  it("validates account and lowercases email (no phone)", () => {
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
      }).success
    ).toBe(false);
  });

  it("requires availability", () => {
    expect(
      locationFormSchema.safeParse({
        countryCode: COUNTRY_ID,
        cityCode: CITY_ID,
        phone: "211234567",
        phonePrefix: "+64",
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
