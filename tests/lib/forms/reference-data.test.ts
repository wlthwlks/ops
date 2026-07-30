import { describe, it, expect } from "vitest";
import {
  AVAILABILITY_OPTIONS,
  availabilityCodesToLegacyString,
  citiesForCountry,
  findCityByCode,
  getOnboardingReferenceData,
} from "@/lib/forms/reference-data";

describe("reference data", () => {
  it("has 21 availability slots (7 days × 3)", () => {
    expect(AVAILABILITY_OPTIONS).toHaveLength(21);
  });

  it("filters cities by country", () => {
    const gb = citiesForCountry("GB");
    expect(gb.every((c) => c.countryCode === "GB")).toBe(true);
    expect(gb.length).toBeGreaterThan(0);
  });

  it("finds city by code", () => {
    expect(findCityByCode("GB-LON")?.legacyCityLabel).toBe("London");
  });

  it("builds legacy availability string without changing matching codes", () => {
    const s = availabilityCodesToLegacyString(["mon_morning"]);
    expect(s).toMatch(/Monday/);
    expect(s).toMatch(/Morning/);
  });

  it("exports versioned catalogue", () => {
    const d = getOnboardingReferenceData();
    expect(d.version).toBe(1);
    expect(d.businessStages.some((s) => s.code === "EARLY_TRACTION")).toBe(true);
  });
});
