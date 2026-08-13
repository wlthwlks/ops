/**
 * Controlled values for onboarding forms.
 * Location (countries/cities) is loaded live from Airtable — see airtable-catalog.ts.
 * Matching options load from MATCHING OPTIONS when available.
 */
export {
  loadLocationCatalog,
  findCatalogCityByCode,
  findCatalogCountryByCode,
  findCatalogCityByRecordIds,
  resolveMemberLocationDto,
  isAirtableRecordId,
  isAirtableChecked,
  clearLocationCatalogCache,
  setLocationCatalogForTests,
  type CatalogCity,
  type CatalogCountry,
  type LocationCatalog,
} from "./airtable-catalog";

export {
  loadMatchingOptionsCatalog,
  clearMatchingOptionsCache,
  setMatchingOptionsCatalogForTests,
  linkIdsFromField,
  type MatchingOption,
  type MatchingOptionsCatalog,
} from "./matching-options-catalog";

export {
  BUSINESS_STAGES,
  REVENUE_BRACKETS,
  CONNECTION_TYPES,
  HELP_WANTED_OPTIONS,
  EXPERTISE_OPTIONS,
  INDUSTRIES,
  INDUSTRY_CODES,
  AVAILABILITY_OPTIONS,
  availabilityCodesToLegacyString,
  splitIndustryForUi,
  resolveIndustryForWrite,
} from "./static-options";

export {
  resolveCountryIso2,
  resolveCountryDialCode,
  dialCodeForIso2,
  enrichCountriesWithPhoneMeta,
  validatePhoneParts,
  splitStoredPhone,
  defaultDialCodeFromLocale,
  auditCountryPhoneMappings,
  normalizeCountryLabel,
  countryNameForIso2,
  REQUIRED_PHONE_COUNTRY_LABELS,
  type CountryPhoneMeta,
} from "./country-phone";

import {
  dialCodeForIso2,
  resolveCountryIso2,
  validatePhoneParts,
} from "./country-phone";
import { findCatalogCountryByCode } from "./airtable-catalog";

/**
 * Authoritative server-side phone validation: derive the expected country +
 * calling code from the selected Airtable `countryCode` (record id) — never
 * trust phonePrefix / countryIso2 sent by the browser.
 */
export async function resolvePhoneForCountry(
  countryCode: string,
  rawPhone: string
): Promise<
  | { ok: true; e164: string; national: string; prefix: string }
  | { ok: false; message: string }
> {
  const country = await findCatalogCountryByCode(countryCode);
  if (!country) {
    return {
      ok: false,
      message: "Select a country so we can add the correct calling code",
    };
  }
  const iso2 = resolveCountryIso2(country.label);
  const dialCode = dialCodeForIso2(iso2);
  if (!iso2 || !dialCode) {
    return {
      ok: false,
      message: "Select a country so we can add the correct calling code",
    };
  }
  return validatePhoneParts(dialCode, rawPhone, iso2);
}

export async function getOnboardingReferenceData() {
  const { loadLocationCatalog } = await import("./airtable-catalog");
  const { loadMatchingOptionsCatalog } = await import("./matching-options-catalog");
  const { enrichCountriesWithPhoneMeta } = await import("./country-phone");
  const {
    INDUSTRIES,
    BUSINESS_STAGES,
    REVENUE_BRACKETS,
    AVAILABILITY_OPTIONS,
    CONNECTION_TYPES,
  } = await import("./static-options");

  const [location, matching] = await Promise.all([
    loadLocationCatalog(),
    loadMatchingOptionsCatalog(),
  ]);

  return {
    countries: enrichCountriesWithPhoneMeta(location.countries),
    cities: location.cities.map((c) => ({
      code: c.code,
      label: c.label,
      countryCode: c.countryCode,
      timezone: c.timezone,
      legacyCityLabel: c.legacyCityLabel,
    })),
    industries: [...INDUSTRIES],
    businessStages: [...BUSINESS_STAGES],
    revenueBrackets: [...REVENUE_BRACKETS],
    availabilityOptions: AVAILABILITY_OPTIONS.map((o) => ({
      code: o.code,
      label: o.label,
    })),
    helpWantedOptions: matching.helpWantedOptions.map((o) => ({
      code: o.code,
      label: o.label,
    })),
    expertiseOptions: matching.expertiseOptions.map((o) => ({
      code: o.code,
      label: o.label,
    })),
    connectionTypes: [...CONNECTION_TYPES],
    locationSource: location.source,
    locationFetchedAt: location.fetchedAt,
    matchingSource: matching.source,
    matchingFetchedAt: matching.fetchedAt,
    version: 3,
  };
}
