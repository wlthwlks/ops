import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  validatePhoneParts,
  resolvePhoneForCountry,
  setLocationCatalogForTests,
  findCatalogCountryByCode,
} from "@/lib/forms/reference-data";
import {
  locationFormSchema,
  profileFormSchema,
} from "../../../widgets/shared/widget-schemas";

const US_ID = "recus0000000001";
const CA_ID = "recca0000000002";
const NZ_ID = "recnz000000003";
const GB_ID = "recgb0000000004";
const NYC = "recnyc000000005";
const TORONTO = "rectoronto0006";
const AUCKLAND = "recauckland007";

function seedLocations() {
  setLocationCatalogForTests({
    source: "airtable",
    fetchedAt: new Date().toISOString(),
    countries: [
      { code: US_ID, label: "United States" },
      { code: CA_ID, label: "Canada" },
      { code: NZ_ID, label: "New Zealand" },
      { code: GB_ID, label: "United Kingdom" },
    ],
    cities: [
      {
        code: NYC,
        label: "New York",
        countryCode: US_ID,
        countryLabel: "United States",
        timezone: "America/New_York",
        legacyCityLabel: "New York",
        airtableRecordId: NYC,
        hasSlackChannel: true,
        cityTier: "Anchor",
        formEnabled: true,
      },
      {
        code: TORONTO,
        label: "Toronto",
        countryCode: CA_ID,
        countryLabel: "Canada",
        timezone: "America/Toronto",
        legacyCityLabel: "Toronto",
        airtableRecordId: TORONTO,
        hasSlackChannel: true,
        cityTier: "Anchor",
        formEnabled: true,
      },
      {
        code: AUCKLAND,
        label: "Auckland",
        countryCode: NZ_ID,
        countryLabel: "New Zealand",
        timezone: "Pacific/Auckland",
        legacyCityLabel: "Auckland",
        airtableRecordId: AUCKLAND,
        hasSlackChannel: true,
        cityTier: "Anchor",
        formEnabled: true,
      },
    ],
  });
}

describe("validatePhoneParts (server, strict libphonenumber-js/max)", () => {
  describe("local / national numbers", () => {
    it("accepts NZ national without trunk 0", () => {
      const r = validatePhoneParts("+64", "211234567", "NZ");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.e164).toBe("+64211234567");
        expect(r.national).toBe("211234567");
        expect(r.prefix).toBe("+64");
      }
    });

    it("accepts NZ local number with leading trunk 0 and formatting", () => {
      const r = validatePhoneParts("+64", "021 123 4567", "NZ");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.e164).toBe("+64211234567");
    });

    it("accepts UK local landline with spaces and brackets", () => {
      const r = validatePhoneParts("+44", "(020) 7946-0958", "GB");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.e164).toBe("+442079460958");
    });

    it("accepts US local number without international + prefix", () => {
      const r = validatePhoneParts("+1", "212 555 0148", "US");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.e164).toBe("+12125550148");
    });
  });

  describe("full international pasted numbers", () => {
    it("accepts +64 NZ international when NZ selected", () => {
      const r = validatePhoneParts("+64", "+64 21 123 4567", "NZ");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.e164).toBe("+64211234567");
    });

    it("accepts +44 GB international with hyphens/spaces", () => {
      const r = validatePhoneParts("+44", "+44-20-7946-0958", "GB");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.e164).toBe("+442079460958");
    });
  });

  describe("formatting characters", () => {
    it("strips spaces, parens, hyphens and dots in local input", () => {
      const r = validatePhoneParts("+64", "(021) 123.4567", "NZ");
      expect(r.ok).toBe(true);
    });

    it("strips formatting in international input", () => {
      const r = validatePhoneParts("+64", "+64 (21) 123 4567", "NZ");
      expect(r.ok).toBe(true);
    });
  });

  describe("US / Canada shared +1 prefix", () => {
    it("accepts US number with US selected (pasted international)", () => {
      const r = validatePhoneParts("+1", "+1 212 555 0148", "US");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.prefix).toBe("+1");
    });

    it("accepts US local with US selected", () => {
      const r = validatePhoneParts("+1", "2125550148", "US");
      expect(r.ok).toBe(true);
    });

    it("accepts CA number with CA selected (pasted international)", () => {
      const r = validatePhoneParts("+1", "+1 416 555 0148", "CA");
      expect(r.ok).toBe(true);
    });

    it("accepts CA local with CA selected", () => {
      const r = validatePhoneParts("+1", "416 555 0148", "CA");
      expect(r.ok).toBe(true);
    });

    it("rejects CA number with US selected (pasted intl)", () => {
      const r = validatePhoneParts("+1", "+1 416 555 0148", "US");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/Canada/);
    });

    it("rejects US number with CA selected (pasted intl)", () => {
      const r = validatePhoneParts("+1", "+1 212 555 0148", "CA");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/United States/);
    });

    it("rejects CA local typed when US selected", () => {
      const r = validatePhoneParts("+1", "416 555 0148", "US");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/Canada/);
    });

    it("rejects US local typed when CA selected", () => {
      const r = validatePhoneParts("+1", "212 555 0148", "CA");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/United States/);
    });
  });

  describe("wrong country (non-shared code)", () => {
    it("rejects AU international pasted when NZ selected", () => {
      const r = validatePhoneParts("+64", "+61 412 345 678", "NZ");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/Australia/);
    });
  });

  describe("invalid numbers", () => {
    it("rejects too-short input", () => {
      expect(validatePhoneParts("+64", "12", "NZ").ok).toBe(false);
    });
    it("rejects entirely non-digit input", () => {
      expect(validatePhoneParts("+64", "abcdef", "NZ").ok).toBe(false);
    });
    it("rejects garbage that normalizes to too short", () => {
      expect(validatePhoneParts("+64", "()", "NZ").ok).toBe(false);
    });
    it("rejects missing country prefix", () => {
      const r = validatePhoneParts("", "211234567", "NZ");
      expect(r.ok).toBe(false);
    });
  });

  describe("legacy path without iso2 (lenient prefix match)", () => {
    it("still accepts international when iso2 omitted (non-shared prefix)", () => {
      const r = validatePhoneParts("+64", "211234567");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.prefix).toBe("+64");
    });
    it("accepts pasted full international when iso2 omitted", () => {
      const r = validatePhoneParts("+64", "+64 21 123 4567");
      expect(r.ok).toBe(true);
    });
  });
});

describe("resolvePhoneForCountry (server-side authoritative)", () => {
  beforeEach(seedLocations);
  afterEach(() => setLocationCatalogForTests(null));

  it("finds country by Airtable record id from catalogue", async () => {
    const country = await findCatalogCountryByCode(NZ_ID);
    expect(country?.label).toBe("New Zealand");
  });

  it("derives iso2/dial from countryCode (NZ local)", async () => {
    const r = await resolvePhoneForCountry(NZ_ID, "021 123 4567");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.e164).toBe("+64211234567");
      expect(r.prefix).toBe("+64");
    }
  });

  it("rejects when supplied browser iso2 disagrees with selected country", async () => {
    // Client lies about being NZ but selected country is US; only countryCode is
    // trusted. A real NZ number must be rejected for the US selection.
    const r = await resolvePhoneForCountry(US_ID, "+64 21 123 4567");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/New Zealand/);
  });

  it("shared +1: accepts CA number when CA country selected", async () => {
    const r = await resolvePhoneForCountry(CA_ID, "+1 416 555 0148");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.e164).toBe("+14165550148");
  });

  it("shared +1: rejects CA number when US country selected", async () => {
    const r = await resolvePhoneForCountry(US_ID, "+1 416 555 0148");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Canada/);
  });

  it("shared +1: rejects CA local typed when US country selected", async () => {
    const r = await resolvePhoneForCountry(US_ID, "416 555 0148");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Canada/);
  });

  it("fallback error for unknown countryCode", async () => {
    const r = await resolvePhoneForCountry("recnotfound", "211234567");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Select a country/);
  });

  it("does not trust client dial code in payload — using only countryCode", async () => {
    // Even if prefix looks correct, no countryCode resolves → instructions.
    const r = await resolvePhoneForCountry("", "211234567");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Select a country/);
  });
});

describe("widget schema phone validation", () => {
  it("location: accepts NZ local with trunk 0 and formatting", () => {
    const r = locationFormSchema.safeParse({
      countryCode: NZ_ID,
      cityCode: AUCKLAND,
      countryIso2: "NZ",
      phone: "021 123 4567",
      phonePrefix: "+64",
      availability: [],
    });
    expect(r.success).toBe(true);
  });

  it("location: accepts NZ international pasted", () => {
    const r = locationFormSchema.safeParse({
      countryCode: NZ_ID,
      cityCode: AUCKLAND,
      countryIso2: "NZ",
      phone: "+64 21 123 4567",
      phonePrefix: "+64",
    });
    expect(r.success).toBe(true);
  });

  it("location: rejects too-short phone", () => {
    const r = locationFormSchema.safeParse({
      countryCode: NZ_ID,
      cityCode: AUCKLAND,
      countryIso2: "NZ",
      phone: "12",
      phonePrefix: "+64",
    });
    expect(r.success).toBe(false);
  });

  it("location: rejects CA number with US selected (shared +1)", () => {
    const r = locationFormSchema.safeParse({
      countryCode: US_ID,
      cityCode: NYC,
      countryIso2: "US",
      phone: "+1 416 555 0148",
      phonePrefix: "+1",
    });
    expect(r.success).toBe(false);
  });

  it("location: accepts US number with US selected", () => {
    const r = locationFormSchema.safeParse({
      countryCode: US_ID,
      cityCode: NYC,
      countryIso2: "US",
      phone: "212 555 0148",
      phonePrefix: "+1",
    });
    expect(r.success).toBe(true);
  });

  it("profile: accepts formatted NZ number (optional)", () => {
    const r = profileFormSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "(021) 123 4567",
      phonePrefix: "+64",
      countryIso2: "NZ",
    });
    expect(r.success).toBe(true);
  });

  it("profile: rejects wrong-country international pasted", () => {
    const r = profileFormSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "+61 412 345 678",
      phonePrefix: "+64",
      countryIso2: "NZ",
    });
    expect(r.success).toBe(false);
  });
});