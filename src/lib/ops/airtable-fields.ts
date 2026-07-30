/**
 * Table-specific Airtable field maps and live table names.
 * Exact names (case, spaces, punctuation) must match the base schema.
 * Do not share one field map across unrelated tables.
 */

function envField(name: string, fallback: string): string {
  return (process.env[name] || "").trim() || fallback;
}

/**
 * Live Airtable base table names (confirmed via PAT):
 * MEMBERS, MATCH GROUPS, ALL CITIES, DONUT DATA, SLACK CHANNELS, CITY WLKS
 *
 * Airtable often accepts case variants for some tables (e.g. Members/MEMBERS),
 * but "Cities" and "Donut Pairings" 403 — use the names below.
 */
export const MEMBERS_TABLE = envField("AIRTABLE_MEMBERS_TABLE", "MEMBERS");
export const MATCH_GROUPS_TABLE = envField("AIRTABLE_MATCH_GROUPS_TABLE", "MATCH GROUPS");
export const CITIES_TABLE = envField("AIRTABLE_CITIES_TABLE", "ALL CITIES");
export const DONUT_DATA_TABLE = envField("AIRTABLE_DONUT_DATA_TABLE", "DONUT DATA");
export const SLACK_CHANNELS_TABLE = envField(
  "AIRTABLE_SLACK_CHANNELS_TABLE",
  "SLACK CHANNELS"
);
/** City walk events / registrations linked to slack channels. */
export const CITY_WLKS_TABLE = envField("AIRTABLE_CITY_WLKS_TABLE", "CITY WLKS");

/** @deprecated use CITIES_TABLE — kept alias for older imports */
export const CITIES_TABLE_LEGACY_ALIAS = CITIES_TABLE;

/**
 * Members table field map.
 * New form/onboarding fields are optional until created in Airtable —
 * writers omit keys that fail schema checks.
 */
export const MEMBER_FIELDS = {
  name: "Name",
  email: "email",
  slackEmail: "Slack Email",
  /** Legacy text/select city (source during migration). */
  city: envField("AIRTABLE_MEMBER_CITY_LEGACY_FIELD", "City"),
  /** Linked record → ALL CITIES (preferred). Default "City relation". */
  cityRelation: envField("AIRTABLE_MEMBER_CITY_LINK_FIELD", "City relation"),
  membership: "Membership",
  payment: "Payment",
  dateJoined: "Date joined",
  cancellationDate: "Cancellation date",
  serviceAccessUntil: "Service access until",
  stripeCustomerId: "Stripe Customer ID",
  // —— Forms / onboarding (create in Airtable before enabling write flags) ——
  memberstackId: envField("AIRTABLE_MEMBER_MEMBERSTACK_ID_FIELD", "Memberstack ID"),
  firstName: envField("AIRTABLE_MEMBER_FIRST_NAME_FIELD", "First Name"),
  lastName: envField("AIRTABLE_MEMBER_LAST_NAME_FIELD", "Last Name"),
  phone: envField("AIRTABLE_MEMBER_PHONE_FIELD", "phone number"),
  businessName: envField("AIRTABLE_MEMBER_BUSINESS_NAME_FIELD", "Business name"),
  businessWebsite: envField("AIRTABLE_MEMBER_BUSINESS_WEBSITE_FIELD", "Business website"),
  onboardingStatus: envField("AIRTABLE_MEMBER_ONBOARDING_STATUS_FIELD", "Onboarding status"),
  profileSchemaVersion: envField(
    "AIRTABLE_MEMBER_PROFILE_SCHEMA_VERSION_FIELD",
    "Profile schema version"
  ),
  onboardingCompletedAt: envField(
    "AIRTABLE_MEMBER_ONBOARDING_COMPLETED_AT_FIELD",
    "Onboarding completed at"
  ),
  countryCode: envField("AIRTABLE_MEMBER_COUNTRY_CODE_FIELD", "Country code"),
  cityCode: envField("AIRTABLE_MEMBER_CITY_CODE_FIELD", "City code"),
  availabilityCodes: envField(
    "AIRTABLE_MEMBER_AVAILABILITY_CODES_FIELD",
    "Availability codes"
  ),
  /** Legacy free-text availability for existing systems — do not change matching readers. */
  availabilityLegacy: envField("AIRTABLE_MEMBER_AVAILABILITY_LEGACY_FIELD", "Availability"),
  primaryIndustry: envField("AIRTABLE_MEMBER_PRIMARY_INDUSTRY_FIELD", "Primary industry"),
  businessStage: envField("AIRTABLE_MEMBER_BUSINESS_STAGE_FIELD", "Business stage"),
  annualRevenue: envField("AIRTABLE_MEMBER_ANNUAL_REVENUE_FIELD", "Annual revenue"),
  businessDescription: envField(
    "AIRTABLE_MEMBER_BUSINESS_DESCRIPTION_FIELD",
    "Business description"
  ),
  ninetyDayGoal: envField("AIRTABLE_MEMBER_90_DAY_GOAL_FIELD", "90-day goal"),
  goalUpdatedAt: envField("AIRTABLE_MEMBER_GOAL_UPDATED_AT_FIELD", "Goal updated at"),
  helpWanted: envField("AIRTABLE_MEMBER_HELP_WANTED_FIELD", "Help wanted"),
  helpWantedContext: envField(
    "AIRTABLE_MEMBER_HELP_WANTED_CONTEXT_FIELD",
    "Help wanted context"
  ),
  expertiseOffered: envField("AIRTABLE_MEMBER_EXPERTISE_OFFERED_FIELD", "Expertise offered"),
  expertiseContext: envField("AIRTABLE_MEMBER_EXPERTISE_CONTEXT_FIELD", "Expertise context"),
  connectionType: envField("AIRTABLE_MEMBER_CONNECTION_TYPE_FIELD", "Connection type"),
  stripeSubscriptionId: envField(
    "AIRTABLE_MEMBER_STRIPE_SUBSCRIPTION_ID_FIELD",
    "Stripe Subscription ID"
  ),
  cancelAtPeriodEnd: envField(
    "AIRTABLE_MEMBER_CANCEL_AT_PERIOD_END_FIELD",
    "Cancel at period end"
  ),
  cancellationRequestedAt: envField(
    "AIRTABLE_MEMBER_CANCELLATION_REQUESTED_AT_FIELD",
    "Cancellation requested at"
  ),
  cancellationEffectiveAt: envField(
    "AIRTABLE_MEMBER_CANCELLATION_EFFECTIVE_AT_FIELD",
    "Cancellation effective at"
  ),
  utmSource: envField("AIRTABLE_MEMBER_UTM_SOURCE_FIELD", "utm_source"),
  utmMedium: envField("AIRTABLE_MEMBER_UTM_MEDIUM_FIELD", "utm_medium"),
  utmCampaign: envField("AIRTABLE_MEMBER_UTM_CAMPAIGN_FIELD", "utm_campaign"),
  utmContent: envField("AIRTABLE_MEMBER_UTM_CONTENT_FIELD", "utm_content"),
  utmTerm: envField("AIRTABLE_MEMBER_UTM_TERM_FIELD", "utm_term"),
  firstAttributionAt: envField(
    "AIRTABLE_MEMBER_FIRST_ATTRIBUTION_AT_FIELD",
    "First attribution at"
  ),
  initialLandingPage: envField(
    "AIRTABLE_MEMBER_INITIAL_LANDING_PAGE_FIELD",
    "Initial landing page"
  ),
  initialReferrer: envField("AIRTABLE_MEMBER_INITIAL_REFERRER_FIELD", "Initial referrer"),
  lastFormSource: envField("AIRTABLE_MEMBER_LAST_FORM_SOURCE_FIELD", "Last form source"),
} as const;

export const MEMBER_LIST_FIELDS: string[] = [
  MEMBER_FIELDS.name,
  MEMBER_FIELDS.email,
  MEMBER_FIELDS.slackEmail,
  MEMBER_FIELDS.city,
  MEMBER_FIELDS.cityRelation,
  MEMBER_FIELDS.membership,
  MEMBER_FIELDS.payment,
  MEMBER_FIELDS.dateJoined,
  MEMBER_FIELDS.cancellationDate,
  MEMBER_FIELDS.serviceAccessUntil,
  MEMBER_FIELDS.stripeCustomerId,
];

/**
 * SLACK CHANNELS table — exact export columns from Airtable.
 * Do not request Members-only or Cities-only fields here.
 */
export const SLACK_CHANNEL_FIELDS = {
  name: "Name",
  cities: "Cities",
  groupSize: "group size",
  status: "Channel status/donut",
  slackChannelId: "Slack Channel ID",
  introType: "Intro type",
  timezone: "Timezone",
  schedulingMode: "Scheduling mode",
} as const;

export const SLACK_CHANNEL_LIST_FIELDS: string[] = [
  SLACK_CHANNEL_FIELDS.name,
  SLACK_CHANNEL_FIELDS.cities,
  SLACK_CHANNEL_FIELDS.groupSize,
  SLACK_CHANNEL_FIELDS.status,
  SLACK_CHANNEL_FIELDS.slackChannelId,
  SLACK_CHANNEL_FIELDS.timezone,
  SLACK_CHANNEL_FIELDS.schedulingMode,
];

/**
 * ALL CITIES table fields.
 * Do not request "Name" here — primary display field is "City".
 */
export const CITY_FIELDS = {
  city: envField("AIRTABLE_CITY_NAME_FIELD", "City"),
  country: envField("AIRTABLE_CITY_COUNTRY_FIELD", "Country"),
  /** Reciprocal link on ALL CITIES (exact field name is "Slack channels"). */
  slackChannels: envField("AIRTABLE_CITY_CHANNEL_FIELD", "Slack channels"),
} as const;

export const CITY_LIST_FIELDS: string[] = [
  CITY_FIELDS.city,
  CITY_FIELDS.country,
  CITY_FIELDS.slackChannels,
];

export const CITY_WLKS_FIELDS = {
  name: "Name",
  status: "Status",
  slackChannels: "SLACK CHANNELS",
  registrations: "Registrations",
} as const;

export class AirtableSchemaMismatchError extends Error {
  readonly code = "AIRTABLE_SCHEMA_MISMATCH";
  readonly table: string;
  readonly field: string | null;

  constructor(table: string, message: string, field: string | null = null) {
    super(message);
    this.name = "AirtableSchemaMismatchError";
    this.table = table;
    this.field = field;
  }
}

/** Parse Airtable unknown-field errors into structured schema mismatches. */
export function toAirtableSchemaError(
  table: string,
  err: unknown
): AirtableSchemaMismatchError | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m =
    msg.match(/Unknown field name:\s*\\"([^\\"]+)\\"/i) ||
    msg.match(/Unknown field name:\s*"([^"]+)"/i) ||
    msg.match(/Unknown field name:\s*'([^']+)'/i);
  if (!m) return null;
  return new AirtableSchemaMismatchError(
    table,
    `The configured Airtable table "${table}" does not contain expected field "${m[1]}".`,
    m[1]
  );
}
