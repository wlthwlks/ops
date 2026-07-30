/**
 * Single source of truth for onboarding controlled values.
 * Labels may change; stored codes are stable.
 */

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

export const AVAILABILITY_OPTIONS = DAYS.flatMap((day) =>
  SLOTS.map((slot) => ({
    code: `${day}_${slot.key}` as const,
    label: `${DAY_LABELS[day]} ${slot.label}`,
    day,
    slot: slot.key,
  }))
);

export type CityRef = {
  code: string;
  label: string;
  countryCode: string;
  region: string;
  timezone: string;
  latitude: number;
  longitude: number;
  /** Legacy Airtable City text for backward compatibility */
  legacyCityLabel: string;
};

export const COUNTRIES = [
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
  { code: "US", label: "United States" },
  { code: "AE", label: "United Arab Emirates" },
  { code: "AU", label: "Australia" },
  { code: "CA", label: "Canada" },
  { code: "FR", label: "France" },
  { code: "DE", label: "Germany" },
  { code: "NL", label: "Netherlands" },
  { code: "ES", label: "Spain" },
  { code: "PT", label: "Portugal" },
  { code: "OTHER", label: "Other" },
] as const;

/** Starter city catalogue — extend via Airtable later without changing codes. */
export const CITIES: CityRef[] = [
  {
    code: "GB-LON",
    label: "London",
    countryCode: "GB",
    region: "England",
    timezone: "Europe/London",
    latitude: 51.5074,
    longitude: -0.1278,
    legacyCityLabel: "London",
  },
  {
    code: "GB-MAN",
    label: "Manchester",
    countryCode: "GB",
    region: "England",
    timezone: "Europe/London",
    latitude: 53.4808,
    longitude: -2.2426,
    legacyCityLabel: "Manchester",
  },
  {
    code: "GB-BIR",
    label: "Birmingham",
    countryCode: "GB",
    region: "England",
    timezone: "Europe/London",
    latitude: 52.4862,
    longitude: -1.8904,
    legacyCityLabel: "Birmingham",
  },
  {
    code: "GB-EDI",
    label: "Edinburgh",
    countryCode: "GB",
    region: "Scotland",
    timezone: "Europe/London",
    latitude: 55.9533,
    longitude: -3.1883,
    legacyCityLabel: "Edinburgh",
  },
  {
    code: "GB-BRI",
    label: "Bristol",
    countryCode: "GB",
    region: "England",
    timezone: "Europe/London",
    latitude: 51.4545,
    longitude: -2.5879,
    legacyCityLabel: "Bristol",
  },
  {
    code: "IE-DUB",
    label: "Dublin",
    countryCode: "IE",
    region: "Leinster",
    timezone: "Europe/Dublin",
    latitude: 53.3498,
    longitude: -6.2603,
    legacyCityLabel: "Dublin",
  },
  {
    code: "AE-DXB",
    label: "Dubai",
    countryCode: "AE",
    region: "Dubai",
    timezone: "Asia/Dubai",
    latitude: 25.2048,
    longitude: 55.2708,
    legacyCityLabel: "Dubai",
  },
  {
    code: "US-NYC",
    label: "New York",
    countryCode: "US",
    region: "NY",
    timezone: "America/New_York",
    latitude: 40.7128,
    longitude: -74.006,
    legacyCityLabel: "New York",
  },
  {
    code: "US-LAX",
    label: "Los Angeles",
    countryCode: "US",
    region: "CA",
    timezone: "America/Los_Angeles",
    latitude: 34.0522,
    longitude: -118.2437,
    legacyCityLabel: "Los Angeles",
  },
  {
    code: "AU-SYD",
    label: "Sydney",
    countryCode: "AU",
    region: "NSW",
    timezone: "Australia/Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
    legacyCityLabel: "Sydney",
  },
  {
    code: "FR-PAR",
    label: "Paris",
    countryCode: "FR",
    region: "Île-de-France",
    timezone: "Europe/Paris",
    latitude: 48.8566,
    longitude: 2.3522,
    legacyCityLabel: "Paris",
  },
  {
    code: "DE-BER",
    label: "Berlin",
    countryCode: "DE",
    region: "Berlin",
    timezone: "Europe/Berlin",
    latitude: 52.52,
    longitude: 13.405,
    legacyCityLabel: "Berlin",
  },
  {
    code: "NL-AMS",
    label: "Amsterdam",
    countryCode: "NL",
    region: "North Holland",
    timezone: "Europe/Amsterdam",
    latitude: 52.3676,
    longitude: 4.9041,
    legacyCityLabel: "Amsterdam",
  },
  {
    code: "ES-MAD",
    label: "Madrid",
    countryCode: "ES",
    region: "Madrid",
    timezone: "Europe/Madrid",
    latitude: 40.4168,
    longitude: -3.7038,
    legacyCityLabel: "Madrid",
  },
  {
    code: "PT-LIS",
    label: "Lisbon",
    countryCode: "PT",
    region: "Lisbon",
    timezone: "Europe/Lisbon",
    latitude: 38.7223,
    longitude: -9.1393,
    legacyCityLabel: "Lisbon",
  },
];

export function citiesForCountry(countryCode: string): CityRef[] {
  return CITIES.filter((c) => c.countryCode === countryCode);
}

export function findCityByCode(code: string): CityRef | undefined {
  return CITIES.find((c) => c.code === code);
}

/** Legacy multi-select style string for systems that still read free-text availability. */
export function availabilityCodesToLegacyString(codes: string[]): string {
  return codes
    .map((code) => AVAILABILITY_OPTIONS.find((o) => o.code === code)?.label || code)
    .join("; ");
}

export function getOnboardingReferenceData() {
  return {
    countries: [...COUNTRIES],
    cities: CITIES,
    industries: [...INDUSTRIES],
    businessStages: [...BUSINESS_STAGES],
    revenueBrackets: [...REVENUE_BRACKETS],
    availabilityOptions: AVAILABILITY_OPTIONS,
    helpWantedOptions: [...HELP_WANTED_OPTIONS],
    expertiseOptions: [...EXPERTISE_OPTIONS],
    connectionTypes: [...CONNECTION_TYPES],
    version: 1,
  };
}
