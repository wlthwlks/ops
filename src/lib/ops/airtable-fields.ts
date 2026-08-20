/**
 * Table-specific Airtable field maps.
 * Defaults match the canonical CSV schema exactly.
 * Prefer importing AIRTABLE_TABLES / writable helpers from @/lib/airtable/schema.
 */
import {
  AIRTABLE_TABLES,
  assertMembersWritePayload,
} from "@/lib/airtable/schema";

function envField(name: string, fallback: string): string {
  return (process.env[name] || "").trim() || fallback;
}

export const MEMBERS_TABLE = AIRTABLE_TABLES.MEMBERS;
export const MATCH_GROUPS_TABLE = AIRTABLE_TABLES.MATCH_GROUPS;
export const CITIES_TABLE = AIRTABLE_TABLES.ALL_CITIES;
export const DONUT_DATA_TABLE = AIRTABLE_TABLES.DONUT_DATA;
export const SLACK_CHANNELS_TABLE = AIRTABLE_TABLES.SLACK_CHANNELS;
export const CITY_WLKS_TABLE = AIRTABLE_TABLES.CITY_WLKS;
export const COUNTRIES_TABLE = AIRTABLE_TABLES.COUNTRIES;
export const INDUSTRIES_TABLE = AIRTABLE_TABLES.INDUSTRIES;
export const MATCHING_OPTIONS_TABLE = AIRTABLE_TABLES.MATCHING_OPTIONS;

/** @deprecated use CITIES_TABLE */
export const CITIES_TABLE_LEGACY_ALIAS = CITIES_TABLE;

/**
 * MEMBERS field map — values are exact Airtable column names.
 * Keys are app-facing identifiers.
 */
export const MEMBER_FIELDS = {
  /** Computed — read only, never write */
  name: "Name",
  email: "email",
  slackEmail: "Slack Email",
  city: "City",
  cityRelation: "City relation",
  membership: "Membership",
  payment: "Payment",
  dateJoined: "Date joined",
  cancellationDate: "Cancellation date",
  serviceAccessUntil: "Service access until",
  stripeCustomerId: "Stripe Customer ID",
  memberstackId: "Memberstack ID",
  firstName: "First Name",
  lastName: "Last Name",
  age: "Age",
  phone: "phone number",
  phonePrefix: "Phone prefix",
  /** Exact Airtable column used by Pinecone sync and forms */
  postCode: "post code",
  industry: "Industry",
  revenue: "Revenue",
  /** @deprecated use industry — kept for gradual migration of call sites */
  primaryIndustry: "Industry",
  /** @deprecated use revenue */
  annualRevenue: "Revenue",
  onboardingStatus: "Onboarding status",
  lastCompletedSignupStep: "Last completed signup step",
  profileSchemaVersion: "Profile schema version",
  onboardingCompletedAt: "Onboarding completed at",
  profileLastUpdatedAt: "Profile last updated at",
  timezone: "Timezone",
  /** Canonical structured availability codes */
  availabilityV2: "Availability v2",
  /** @deprecated alias → Availability v2 */
  availabilityCodes: "Availability v2",
  availabilityLegacy: "Availability",
  locationDataVersion: "Location data version",
  businessStage: "Business stage",
  connectionType: "Connection type",
  businessDescription: "Business description",
  ninetyDayGoal: "Current 90-day goal",
  goalUpdatedAt: "Goal updated at",
  /** Linked multi → MATCHING OPTIONS (record ids) */
  helpWanted: "Help wanted",
  helpWantedContext: "Help wanted context",
  /** Linked multi → MATCHING OPTIONS (record ids). Exact name is Expertise. */
  expertise: "Expertise",
  expertiseContext: "Expertise context",
  topicsToDiscuss: "Topics to Discuss",
  stripeSubscriptionId: "Stripe Subscription ID",
  stripePriceId: "Stripe Price ID",
  memberstackPlanId: "Memberstack Plan ID",
  stripeSubscriptionStatus: "Stripe subscription status",
  cancelAtPeriodEnd: "Cancel at period end",
  cancellationRequestedAt: "Cancellation requested at",
  cancellationEffectiveAt: "Cancellation effective at",
  lastInvoiceId: "Last invoice ID",
  lastInvoiceStatus: "Last invoice status",
  lastPaymentFailureCode: "Last payment failure code",
  lastPaymentFailureMessage: "Last payment failure message",
  billingLastSyncedAt: "Billing last synced at",
  lastStripeEventId: "Last Stripe event ID",
  utmSource: "UTM Source",
  utmMedium: "UTM Medium",
  utmCampaign: "UTM Campaign",
  utmContent: "UTM Content",
  utmTerm: "UTM Term",
  googleClickId: "Google Click ID",
  facebookClickId: "Facebook Click ID",
  firstAttributionAt: "First attribution captured at",
  initialLandingPage: "Initial landing page",
  initialReferrer: "Initial referrer",
  recurringIntroStatus: "Recurring intro status",
  recurringPauseUntil: "Recurring pause until",
  /** Stripe pause-collection resume date; blank = paused indefinitely. */
  billingPauseUntil: "Billing pause until",
  firstIntroductionStatus: "First introduction status",
  firstIntroductionSentAt: "First introduction sent at",
  recurringEligibleFrom: "Recurring eligible from",
  businessName: "Business name",
  businessWebsite: "Business website",
  socialMedia: "social media",
  professionalHeadline: "Professional Headline",
  profileBio: "Profile Bio",
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
  MEMBER_FIELDS.memberstackId,
  MEMBER_FIELDS.firstName,
  MEMBER_FIELDS.lastName,
  MEMBER_FIELDS.onboardingStatus,
];

export const SLACK_CHANNEL_FIELDS = {
  name: "Name",
  cities: "Cities",
  groupSize: "group size",
  status: "Channel status/donut",
  slackChannelId: "Slack Channel ID",
  introType: "Intro type",
  timezone: "Timezone",
  schedulingMode: "Scheduling mode",
  introMessageTemplate: "Intro message template",
  introFrequencyWeeks: "Intro frequency weeks",
  nextIntroductionDate: "Next introduction date",
  introLocalTime: "Intro local time",
  strictGroupSize: "Strict group size",
  members: "Members",
  countMembers: "Count (Members)",
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

export const CITY_FIELDS = {
  city: "City",
  country: "Country",
  slackChannels: "Slack channels",
  cityCode: "City Code",
  region: "Region",
  timezone: "Timezone",
  latitude: "Latitude",
  longitude: "Longitude",
  aliases: "Aliases",
  formEnabled: "Form enabled",
  sortOrder: "Sort order",
  intros: "intros",
  members: "Members",
  active: "Active",
} as const;

export const CITY_LIST_FIELDS: string[] = [
  CITY_FIELDS.city,
  CITY_FIELDS.country,
  CITY_FIELDS.slackChannels,
  CITY_FIELDS.cityCode,
];

export const CITY_WLKS_FIELDS = {
  name: "Name",
  status: "Status",
  slackChannels: "SLACK CHANNELS",
  registrations: "Registrations",
} as const;

export const MATCH_GROUP_FIELDS = {
  recordId: "Record ID",
  introductionDate: "Introduction date",
  status: "Status",
  member1: "Member 1",
  member2: "Member 2",
  member3: "Member 3",
  source: "Source",
  cycleId: "Cycle ID",
  slackChannel: "Slack Channel",
  slackConversationId: "Slack Conversation ID",
  slackMessageTimestamp: "Slack Message Timestamp",
  sendError: "Send error",
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
    msg.match(/Unknown field name:\s*'([^']+)'/i) ||
    msg.match(/does not contain expected field "([^"]+)"/i) ||
    msg.match(/Field "([^"]+)" cannot accept/i);
  if (!m) return null;
  return new AirtableSchemaMismatchError(
    table,
    `The configured Airtable table "${table}" does not contain expected field "${m[1]}".`,
    m[1]
  );
}

/** Validate and return a MEMBERS write payload (drops/throws on bad keys). */
export function sanitizeMembersWriteFields(
  fields: Record<string, unknown>,
  context?: string
): Record<string, unknown> {
  return assertMembersWritePayload(fields, context);
}

// silence unused envField if only used for optional overrides elsewhere
void envField;
