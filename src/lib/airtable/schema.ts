/**
 * Canonical Airtable table and field names — sole source of truth for this app.
 * Names must match Airtable exactly (case, spaces, punctuation).
 * Do not invent fields. Do not fuzzy-match at runtime.
 */

function envTable(name: string, fallback: string): string {
  return (process.env[name] || "").trim() || fallback;
}

export const AIRTABLE_TABLES = {
  MEMBERS: envTable("AIRTABLE_MEMBERS_TABLE", "MEMBERS"),
  MATCH_GROUPS: envTable("AIRTABLE_MATCH_GROUPS_TABLE", "MATCH GROUPS"),
  ALL_CITIES: envTable("AIRTABLE_CITIES_TABLE", "ALL CITIES"),
  SLACK_CHANNELS: envTable("AIRTABLE_SLACK_CHANNELS_TABLE", "SLACK CHANNELS"),
  COUNTRIES: envTable("AIRTABLE_COUNTRIES_TABLE", "COUNTRIES"),
  INDUSTRIES: envTable("AIRTABLE_INDUSTRIES_TABLE", "INDUSTRIES"),
  MATCHING_OPTIONS: envTable("AIRTABLE_MATCHING_OPTIONS_TABLE", "MATCHING OPTIONS"),
  /** Legacy / optional — not in the seven-table form schema audit list */
  DONUT_DATA: envTable("AIRTABLE_DONUT_DATA_TABLE", "DONUT DATA"),
  CITY_WLKS: envTable("AIRTABLE_CITY_WLKS_TABLE", "CITY WLKS"),
} as const;

/** Every valid MEMBERS column name from the CSV header audit. */
export const MEMBERS_CANONICAL_FIELDS = [
  "Name",
  "email",
  "Record ID",
  "Stripe Customer ID",
  "Payment",
  "Membership",
  "Already matched with",
  "Slack Email",
  "First Name",
  "Last Name",
  "phone number",
  "City",
  "Industry",
  "Revenue",
  "Paid Plans (price ids)",
  "Date joined",
  "Memberstack ID",
  "Last Modified Date",
  "Cancellation date",
  "Subscription Fee ($)",
  "Rematch Request Date",
  "Topics to Discuss",
  "Availability",
  "Recurring intro status",
  "Recurring pause until",
  "Service access until",
  "First introduction status",
  "First introduction sent at",
  "Recurring eligible from",
  "Timezone",
  "City relation",
  "Onboarding status",
  "Last completed signup step",
  "Profile schema version",
  "Onboarding completed at",
  "Profile last updated at",
  "UTM Source",
  "UTM Medium",
  "UTM Campaign",
  "UTM Content",
  "UTM Term",
  "Google Click ID",
  "Facebook Click ID",
  "Initial landing page",
  "Initial referrer",
  "First attribution captured at",
  "Availability v2",
  "Location data version",
  "Business stage",
  "Connection type",
  "Business description",
  "Current 90-day goal",
  "Goal updated at",
  "Help wanted context",
  "Expertise context",
  "Stripe Subscription ID",
  "Stripe Price ID",
  "Memberstack Plan ID",
  "Stripe subscription status",
  "Cancel at period end",
  "Cancellation requested at",
  "Cancellation effective at",
  "Last invoice ID",
  "Last invoice status",
  "Last payment failure code",
  "Last payment failure message",
  "Billing last synced at",
  "Last Stripe event ID",
] as const;

export type MembersCanonicalField = (typeof MEMBERS_CANONICAL_FIELDS)[number];

const MEMBERS_CANONICAL_SET = new Set<string>(MEMBERS_CANONICAL_FIELDS);

/**
 * MEMBERS fields safe to include in create/update payloads.
 * Excludes computed/formula/system columns.
 */
export const MEMBERS_WRITABLE_FIELDS = [
  "email",
  "Stripe Customer ID",
  "Payment",
  "Membership",
  "Already matched with",
  "Slack Email",
  "First Name",
  "Last Name",
  "phone number",
  "City",
  "Industry",
  "Revenue",
  "Paid Plans (price ids)",
  "Date joined",
  "Memberstack ID",
  "Cancellation date",
  "Subscription Fee ($)",
  "Rematch Request Date",
  "Topics to Discuss",
  "Availability",
  "Recurring intro status",
  "Recurring pause until",
  "Service access until",
  "First introduction status",
  "First introduction sent at",
  "Recurring eligible from",
  "Timezone",
  "City relation",
  "Onboarding status",
  "Last completed signup step",
  "Profile schema version",
  "Onboarding completed at",
  "Profile last updated at",
  "UTM Source",
  "UTM Medium",
  "UTM Campaign",
  "UTM Content",
  "UTM Term",
  "Google Click ID",
  "Facebook Click ID",
  "Initial landing page",
  "Initial referrer",
  "First attribution captured at",
  "Availability v2",
  "Location data version",
  "Business stage",
  "Connection type",
  "Business description",
  "Current 90-day goal",
  "Goal updated at",
  "Help wanted context",
  "Expertise context",
  "Stripe Subscription ID",
  "Stripe Price ID",
  "Memberstack Plan ID",
  "Stripe subscription status",
  "Cancel at period end",
  "Cancellation requested at",
  "Cancellation effective at",
  "Last invoice ID",
  "Last invoice status",
  "Last payment failure code",
  "Last payment failure message",
  "Billing last synced at",
  "Last Stripe event ID",
] as const;

const MEMBERS_WRITABLE_SET = new Set<string>(MEMBERS_WRITABLE_FIELDS);

/** Read-only / computed MEMBERS fields — never write. */
export const MEMBERS_READONLY_FIELDS = [
  "Name",
  "Record ID",
  "Last Modified Date",
] as const;

export const ALL_CITIES_CANONICAL_FIELDS = [
  "City",
  "Active",
  "City Tier",
  "WC member contact/confirm",
  "Churned",
  "Country",
  "Members",
  "Donut data",
  "intros",
  "% introduced to messaged",
  "Slack channels",
  "% introduced to met Rollup (from Donut data)",
  "City Code",
  "Region",
  "Timezone",
  "Latitude",
  "Longitude",
  "Aliases",
  "Form enabled",
  "Sort order",
] as const;

export const SLACK_CHANNELS_CANONICAL_FIELDS = [
  "Name",
  "Cities",
  "count on jul 15",
  "group size",
  "Channel status/donut",
  "Slack Channel ID",
  "Intro type",
  "Strict group size",
  "Intro message template",
  "Intro frequency weeks",
  "Next introduction date",
  "Intro local time",
  "Timezone",
  "Scheduling mode",
  "Members",
  "Count (Members)",
] as const;

export const MATCH_GROUPS_CANONICAL_FIELDS = [
  "Record ID",
  "Introduction date",
  "Status",
  "Member 1",
  "Member 2",
  "Member 3",
  "Source",
  "Cycle ID",
  "Slack Channel",
  "Slack Conversation ID",
  "Slack Message Timestamp",
  "Send error",
] as const;

export function isMembersCanonicalField(name: string): boolean {
  return MEMBERS_CANONICAL_SET.has(name);
}

export function isMembersWritableField(name: string): boolean {
  return MEMBERS_WRITABLE_SET.has(name);
}

/**
 * Strip non-writable keys from a MEMBERS payload.
 * Throws in development/test when unsupported keys are present.
 */
export function assertMembersWritePayload(
  fields: Record<string, unknown>,
  context = "MEMBERS write"
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const invalid: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!isMembersWritableField(key)) {
      invalid.push(key);
      continue;
    }
    out[key] = value;
  }

  if (invalid.length > 0) {
    const msg = `Unsupported Airtable field(s) for table "MEMBERS" (${context}): ${invalid
      .map((k) => JSON.stringify(k))
      .join(", ")}`;
    if (process.env.NODE_ENV !== "production") {
      throw new Error(msg);
    }
    // Production: drop invalid keys silently (avoid user-facing schema leakage)
    console.error(JSON.stringify({ event: "airtable_schema_strip", context, invalid }));
  }

  return out;
}

export function assertNoForbiddenMembersWrites(fields: Record<string, unknown>): void {
  for (const key of Object.keys(fields)) {
    if (key === "Name" || key === "Last form source") {
      throw new Error(
        `Forbidden Airtable write field ${JSON.stringify(key)} for table "MEMBERS"`
      );
    }
  }
}
