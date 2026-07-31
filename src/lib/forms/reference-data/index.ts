/**
 * Controlled values for onboarding forms.
 * Location (countries/cities) is loaded live from Airtable — see airtable-catalog.ts.
 * Other option lists are stable app codes written to MEMBERS single/multi-selects.
 */

export {
  loadLocationCatalog,
  findCatalogCityByCode,
  findCatalogCityByRecordIds,
  resolveMemberLocationDto,
  isAirtableRecordId,
  clearLocationCatalogCache,
  setLocationCatalogForTests,
  type CatalogCity,
  type CatalogCountry,
  type LocationCatalog,
} from "./airtable-catalog";

export const BUSINESS_STAGES = [
  { code: "EXPLORING_IDEA", label: "Exploring an idea" },
  { code: "PRE_LAUNCH", label: "Pre-launch" },
  { code: "VALIDATING", label: "Validating" },
  { code: "EARLY_TRACTION", label: "Early traction" },
  { code: "CONSISTENT_REVENUE", label: "Consistent revenue" },
  { code: "GROWING_TEAM", label: "Growing a team" },
  { code: "SCALING", label: "Scaling" },
  { code: "ESTABLISHED", label: "Established" },
  { code: "EXIT_TRANSITION", label: "Exit / transition" },
] as const;

export const REVENUE_BRACKETS = [
  { code: "PRE_REVENUE", label: "Pre-revenue" },
  { code: "0_10K", label: "£0–£10k" },
  { code: "10K_50K", label: "£10k–£50k" },
  { code: "50K_100K", label: "£50k–£100k" },
  { code: "100K_500K", label: "£100k–£500k" },
  { code: "500K_1M", label: "£500k–£1m" },
  { code: "1M_2M", label: "£1m–£2m" },
  { code: "2M_5M", label: "£2m–£5m" },
  { code: "5M_10M", label: "£5m–£10m" },
  { code: "10M_20M", label: "£10m–£20m" },
  { code: "20M_PLUS", label: "£20m+" },
  { code: "PREFER_NOT_TO_SAY", label: "Prefer not to say" },
] as const;

export const CONNECTION_TYPES = [
  { code: "SIMILAR_STAGE_PEER", label: "Similar-stage peer" },
  { code: "MORE_EXPERIENCED_GUIDE", label: "More experienced guide" },
  { code: "ACCOUNTABILITY_PARTNER", label: "Accountability partner" },
  { code: "COLLABORATOR_OR_REFERRAL", label: "Collaborator or referral" },
  { code: "I_CAN_MENTOR", label: "I can mentor others" },
  { code: "LOCAL_CONNECTION", label: "Local connection" },
  { code: "NO_PREFERENCE", label: "No preference" },
] as const;

export const HELP_WANTED_OPTIONS = [
  { code: "GROWTH_MARKETING", label: "Growth & marketing" },
  { code: "SALES", label: "Sales" },
  { code: "PRODUCT", label: "Product" },
  { code: "FUNDRAISING", label: "Fundraising" },
  { code: "OPERATIONS", label: "Operations" },
  { code: "HIRING", label: "Hiring & team" },
  { code: "FINANCE", label: "Finance" },
  { code: "TECHNOLOGY", label: "Technology" },
  { code: "MINDSET", label: "Mindset & accountability" },
  { code: "NETWORKING", label: "Networking introductions" },
] as const;

export const EXPERTISE_OPTIONS = [
  { code: "GROWTH_MARKETING", label: "Growth & marketing" },
  { code: "SALES", label: "Sales" },
  { code: "PRODUCT", label: "Product" },
  { code: "FUNDRAISING", label: "Fundraising" },
  { code: "OPERATIONS", label: "Operations" },
  { code: "HIRING", label: "Hiring & team" },
  { code: "FINANCE", label: "Finance" },
  { code: "TECHNOLOGY", label: "Technology" },
  { code: "LEADERSHIP", label: "Leadership" },
  { code: "INDUSTRY_KNOWLEDGE", label: "Industry knowledge" },
] as const;

export const INDUSTRIES = [
  { code: "TECH_SAAS", label: "Tech / SaaS" },
  { code: "ECOMMERCE", label: "E-commerce" },
  { code: "PROFESSIONAL_SERVICES", label: "Professional services" },
  { code: "HEALTH_WELLNESS", label: "Health & wellness" },
  { code: "CREATIVE_MEDIA", label: "Creative & media" },
  { code: "FINANCE", label: "Finance" },
  { code: "EDUCATION", label: "Education" },
  { code: "REAL_ESTATE", label: "Real estate" },
  { code: "HOSPITALITY", label: "Hospitality" },
  { code: "CONSUMER", label: "Consumer" },
  { code: "OTHER", label: "Other" },
] as const;

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const SLOTS = [
  { key: "morning", label: "Morning (08:00–12:00)" },
  { key: "afternoon", label: "Afternoon (12:00–17:00)" },
  { key: "evening", label: "Evening (17:00–21:00)" },
] as const;

const DAY_LABELS: Record<(typeof DAYS)[number], string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** Exact Airtable Availability v2 multi-select option names. */
export const AVAILABILITY_OPTIONS = DAYS.flatMap((day) =>
  SLOTS.map((slot) => ({
    code: `${day}_${slot.key}` as const,
    label: `${DAY_LABELS[day]} ${slot.label}`,
    day,
    slot: slot.key,
  }))
);

export function availabilityCodesToLegacyString(codes: string[]): string {
  return codes
    .map((code) => AVAILABILITY_OPTIONS.find((o) => o.code === code)?.label || code)
    .join("; ");
}

export async function getOnboardingReferenceData() {
  const { loadLocationCatalog } = await import("./airtable-catalog");
  const location = await loadLocationCatalog();
  return {
    countries: location.countries,
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
    helpWantedOptions: [...HELP_WANTED_OPTIONS],
    expertiseOptions: [...EXPERTISE_OPTIONS],
    connectionTypes: [...CONNECTION_TYPES],
    locationSource: location.source,
    locationFetchedAt: location.fetchedAt,
    version: 2,
  };
}
