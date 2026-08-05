import { describe, it, expect } from "vitest";
import {
  resolveCountryDialCode,
  validatePhoneParts,
  splitStoredPhone,
  REQUIRED_PHONE_COUNTRY_LABELS,
  defaultDialCodeFromLocale,
  enrichCountriesWithPhoneMeta,
} from "@/lib/forms/reference-data/country-phone";

describe("country phone mapping", () => {
  it("maps required product countries to expected calling codes", () => {
    const expected: Record<string, string> = {
      "New Zealand": "+64",
      Australia: "+61",
      "United Kingdom": "+44",
      Ireland: "+353",
      "United States": "+1",
      Canada: "+1",
      "United Arab Emirates": "+971",
      UAE: "+971",
      Germany: "+49",
      France: "+33",
      Spain: "+34",
      Portugal: "+351",
      Netherlands: "+31",
      Italy: "+39",
      Mexico: "+52",
      Brazil: "+55",
      "South Africa": "+27",
      Singapore: "+65",
      Japan: "+81",
      India: "+91",
      Malaysia: "+60",
      Vietnam: "+84",
      Nigeria: "+234",
      Argentina: "+54",
      Qatar: "+974",
    };

    for (const label of REQUIRED_PHONE_COUNTRY_LABELS) {
      const { iso2, dialCode } = resolveCountryDialCode(label);
      expect(iso2, label).toBeTruthy();
      expect(dialCode, label).toBe(expected[label]);
    }
  });

  it("validates NZ mobile numbers", () => {
    const ok = validatePhoneParts("+64", "211234567");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.e164).toBe("+64211234567");
  });

  it("rejects invalid phone input", () => {
    const bad = validatePhoneParts("+64", "12");
    expect(bad.ok).toBe(false);
  });

  it("splits legacy full international numbers", () => {
    const parts = splitStoredPhone("+61412345678", "");
    expect(parts.phonePrefix).toBe("+61");
    expect(parts.phone).toMatch(/^\d+$/);
    expect(parts.legacyUnparsed).toBe(false);
  });

  it("prefers separate prefix column", () => {
    const parts = splitStoredPhone("211234567", "+64");
    expect(parts.phonePrefix).toBe("+64");
    expect(parts.phone).toBe("211234567");
  });

  it("preserves unparseable legacy values", () => {
    const parts = splitStoredPhone("ext 123 office", "");
    expect(parts.phone).toBe("ext 123 office");
    expect(parts.legacyUnparsed).toBe(true);
  });

  it("defaults dial code from locale", () => {
    const nz = defaultDialCodeFromLocale("en-NZ");
    expect(nz.dialCode).toBe("+64");
    const au = defaultDialCodeFromLocale("en-AU");
    expect(au.dialCode).toBe("+61");
  });

  it("enriches catalogue countries without guessing unmapped labels", () => {
    const rows = enrichCountriesWithPhoneMeta([
      { code: "rec1", label: "New Zealand" },
      { code: "rec2", label: "Atlantis Colony" },
    ]);
    expect(rows[0].dialCode).toBe("+64");
    expect(rows[1].iso2).toBeNull();
    expect(rows[1].dialCode).toBeNull();
  });
});
