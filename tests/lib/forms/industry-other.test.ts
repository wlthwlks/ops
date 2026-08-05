import { describe, it, expect } from "vitest";
import {
  INDUSTRIES,
  resolveIndustryForWrite,
  splitIndustryForUi,
} from "@/lib/forms/reference-data";
import { businessSchema } from "@/lib/forms/schemas/onboarding";

describe("industry coaching + other", () => {
  it("includes COACHING in controlled list", () => {
    expect(INDUSTRIES.some((i) => i.code === "COACHING" && i.label === "Coaching")).toBe(
      true
    );
  });

  it("writes OTHER custom text into Industry", () => {
    expect(resolveIndustryForWrite("OTHER", "  Sustainable fashion  ")).toBe(
      "Sustainable fashion"
    );
    expect(resolveIndustryForWrite("COACHING", "")).toBe("COACHING");
    expect(resolveIndustryForWrite("TECH_SAAS", "ignored")).toBe("TECH_SAAS");
  });

  it("round-trips custom industry into OTHER UI", () => {
    expect(splitIndustryForUi("Boutique hospitality")).toEqual({
      primaryIndustry: "OTHER",
      otherIndustry: "Boutique hospitality",
    });
    expect(splitIndustryForUi("COACHING")).toEqual({
      primaryIndustry: "COACHING",
      otherIndustry: "",
    });
  });

  it("requires otherIndustry when OTHER selected", () => {
    const base = {
      primaryIndustry: "OTHER" as const,
      businessStage: "EARLY_TRACTION" as const,
      annualRevenue: "10K_50K" as const,
      businessDescription:
        "We help independent founders grow through peer community and introductions in major cities worldwide.",
    };
    expect(businessSchema.safeParse({ ...base, otherIndustry: "" }).success).toBe(false);
    expect(businessSchema.safeParse({ ...base, otherIndustry: "Other" }).success).toBe(
      false
    );
    expect(
      businessSchema.safeParse({ ...base, otherIndustry: "Climate tech advisory" }).success
    ).toBe(true);
  });
});
