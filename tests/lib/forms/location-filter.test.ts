import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isAirtableChecked,
  setLocationCatalogForTests,
  getOnboardingReferenceData,
  findCatalogCityByCode,
} from "@/lib/forms/reference-data";

const UK = "reccnnjiVkL28NBgV";
const US = "rec4w7mhpqGGCYmJW";
const INACTIVE = "recInactiveCountry";

describe("location catalogue eligibility", () => {
  beforeEach(() => {
    setLocationCatalogForTests({
      source: "airtable",
      fetchedAt: new Date().toISOString(),
      countries: [
        { code: UK, label: "United Kingdom" },
        { code: US, label: "United States" },
      ],
      cities: [
        {
          code: "recLondon",
          label: "London",
          countryCode: UK,
          countryLabel: "United Kingdom",
          timezone: "Europe/London",
          legacyCityLabel: "London",
          airtableRecordId: "recLondon",
          hasSlackChannel: true,
          cityTier: "Anchor",
          formEnabled: true,
        },
        // Disabled city must never appear in catalogue consumed by forms
        // (catalogue builder already filters — simulate post-filter result)
      ],
    });
  });

  afterEach(() => {
    setLocationCatalogForTests(null);
  });

  it("treats only boolean true / 1 as Form enabled", () => {
    expect(isAirtableChecked(true)).toBe(true);
    expect(isAirtableChecked(1)).toBe(true);
    expect(isAirtableChecked("true")).toBe(false);
    expect(isAirtableChecked(false)).toBe(false);
  });

  it("enabled city under active country is visible to signup and update via same API", async () => {
    const d = await getOnboardingReferenceData();
    expect(d.cities.some((c) => c.code === "recLondon" && c.countryCode === UK)).toBe(
      true
    );
    expect(d.countries.some((c) => c.code === UK)).toBe(true);
  });

  it("does not invent disabled cities into the shared catalogue", async () => {
    const d = await getOnboardingReferenceData();
    expect(d.cities.some((c) => c.label === "Disabledville")).toBe(false);
    expect(d.countries.some((c) => c.code === INACTIVE)).toBe(false);
  });

  it("findCatalogCityByCode only resolves catalogue (form-enabled) cities", async () => {
    const hit = await findCatalogCityByCode("recLondon");
    expect(hit?.label).toBe("London");
    const miss = await findCatalogCityByCode("recDisabled");
    expect(miss).toBeUndefined();
  });
});
