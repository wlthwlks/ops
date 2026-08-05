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
      phone: "211234567",
      phonePrefix: "+64",
    });
    expect(r.email).toBe("ada@wlth.com");
    expect(r.phonePrefix).toBe("+64");
  });

  it("rejects short password", () => {
    expect(
      accountFormSchema.safeParse({
        firstName: "A",
        lastName: "B",
        email: "a@b.com",
        password: "short",
        phone: "211234567",
        phonePrefix: "+64",
      }).success
    ).toBe(false);
  });

  it("requires valid phone on account", () => {
    expect(
      accountFormSchema.safeParse({
        firstName: "A",
        lastName: "B",
        email: "a@b.com",
        password: "password1",
        phone: "12",
        phonePrefix: "+64",
      }).success
    ).toBe(false);
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
        countryCode: "reccnnjiVkL28NBgV",
        cityCode: "rec8cL36vOg1PpgIY",
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
