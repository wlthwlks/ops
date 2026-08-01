import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AVAILABILITY_OPTIONS,
  availabilityCodesToLegacyString,
  getOnboardingReferenceData,
  setLocationCatalogForTests,
  isAirtableRecordId,
  findCatalogCityByCode,
  isAirtableChecked,
} from "@/lib/forms/reference-data";

describe("reference data", () => {
  beforeEach(() => {
    setLocationCatalogForTests({
      source: "airtable",
      fetchedAt: new Date().toISOString(),
      countries: [
        { code: "reccnnjiVkL28NBgV", label: "United Kingdom" },
        { code: "rec4w7mhpqGGCYmJW", label: "United States" },
      ],
      cities: [
        {
          code: "rec8cL36vOg1PpgIY",
          label: "London",
          countryCode: "reccnnjiVkL28NBgV",
          countryLabel: "United Kingdom",
          timezone: "Europe/London",
          legacyCityLabel: "London",
          airtableRecordId: "rec8cL36vOg1PpgIY",
          hasSlackChannel: true,
          cityTier: "Anchor",
          formEnabled: true,
        },
        {
          code: "rectdJywsSsFNj5Wa",
          label: "New York",
          countryCode: "rec4w7mhpqGGCYmJW",
          countryLabel: "United States",
          timezone: "America/New_York",
          legacyCityLabel: "New York",
          airtableRecordId: "rectdJywsSsFNj5Wa",
          hasSlackChannel: true,
          cityTier: "Anchor",
          formEnabled: true,
        },
      ],
    });
  });

  afterEach(() => {
    setLocationCatalogForTests(null);
  });

  it("has 21 availability slots (7 days × 3) with Airtable option codes", () => {
    expect(AVAILABILITY_OPTIONS).toHaveLength(21);
    expect(AVAILABILITY_OPTIONS.map((o) => o.code)).toContain("mon_morning");
    expect(AVAILABILITY_OPTIONS.map((o) => o.code)).toContain("sun_evening");
  });

  it("recognizes Airtable record ids", () => {
    expect(isAirtableRecordId("rec8cL36vOg1PpgIY")).toBe(true);
    expect(isAirtableRecordId("GB-LON")).toBe(false);
  });

  it("finds city by Airtable record id from catalogue", async () => {
    const city = await findCatalogCityByCode("rec8cL36vOg1PpgIY");
    expect(city?.label).toBe("London");
    expect(city?.countryCode).toBe("reccnnjiVkL28NBgV");
  });

  it("builds legacy availability string without changing matching codes", () => {
    const s = availabilityCodesToLegacyString(["mon_morning"]);
    expect(s).toMatch(/Monday/);
    expect(s).toMatch(/Morning/);
  });

  it("exports versioned catalogue from live location cache", async () => {
    const d = await getOnboardingReferenceData();
    expect(d.version).toBe(2);
    expect(d.countries.some((c) => c.label === "United Kingdom")).toBe(true);
    expect(d.cities.some((c) => c.label === "London")).toBe(true);
    expect(d.businessStages.some((s) => s.code === "EARLY_TRACTION")).toBe(true);
    expect(d.locationSource).toBe("airtable");
  });

  it("treats Airtable checkboxes as boolean true only", () => {
    expect(isAirtableChecked(true)).toBe(true);
    expect(isAirtableChecked(1)).toBe(true);
    expect(isAirtableChecked(false)).toBe(false);
    expect(isAirtableChecked(0)).toBe(false);
    expect(isAirtableChecked("true")).toBe(false);
    expect(isAirtableChecked(null)).toBe(false);
  });
});
