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

/** Members table — only fields that exist on MEMBERS. */
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
