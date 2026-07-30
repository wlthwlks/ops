export type IssueSeverity = "critical" | "high" | "medium" | "info";

export type MemberIssueCode =
  | "PAYING_STRIPE_CUSTOMER_MISSING_AIRTABLE"
  | "DUPLICATE_AIRTABLE_EMAIL"
  | "MULTIPLE_STRIPE_CUSTOMERS_FOR_EMAIL"
  | "STRIPE_CUSTOMER_ID_CONFLICT"
  | "STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS"
  | "INVALID_SERVICE_ACCESS_DATE"
  | "ACTIVE_PAID_MEMBER_WITHOUT_QUALIFYING_STRIPE_PAYMENT"
  | "SERVICE_ELIGIBLE_MEMBER_NOT_IN_SLACK"
  | "AIRTABLE_SLACK_EMAIL_POINTS_TO_NO_ACTIVE_USER"
  | "ACTIVE_MEMBER_HAS_DEACTIVATED_SLACK_ACCOUNT"
  | "SLACK_IDENTITY_MATCH_AMBIGUOUS"
  | "MEMBER_NOT_IN_CITY_CHANNEL"
  | "MEMBER_NOT_IN_ALL_MEMBERS_CHANNEL"
  | "CITY_CHANNEL_NOT_CONFIGURED"
  | "MEMBER_CITY_MISSING"
  | "AIRTABLE_MEMBER_MISSING_STRIPE_CUSTOMER_ID"
  | "PRIMARY_EMAIL_MISSING"
  | "PRIMARY_EMAIL_INVALID"
  | "SLACK_EMAIL_MISSING_BUT_PRIMARY_EMAIL_MATCHES"
  | "SERVICE_ACCESS_DATE_BEHIND_STRIPE"
  | "AIRTABLE_PAYMENT_STATUS_DISAGREES_WITH_STRIPE"
  | "FULLY_CONNECTED"
  | "CANCELLED_WITH_VALID_SERVICE_ACCESS"
  | "SERVICE_ACCESS_LATER_THAN_STRIPE"
  | "EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE";

export type MemberIssue = {
  code: MemberIssueCode;
  severity: IssueSeverity;
  label: string;
  explanation: string;
  recommendedAction: string;
  systems: Array<"airtable" | "stripe" | "slack" | "config">;
};

export type SlackIdentityState =
  | "matched_primary_email"
  | "matched_slack_email"
  | "suggested_name"
  | "ambiguous"
  | "stale_slack_email"
  | "deactivated"
  | "not_found"
  | "not_checked";

export type ChannelMembershipState =
  | "member"
  | "not_member"
  | "not_configured"
  | "not_checked"
  | "error";

export type MemberHealthRow = {
  airtableRecordId: string | null;
  name: string;
  primaryEmail: string;
  slackEmail: string;
  city: string;
  membership: string;
  payment: string;
  dateJoined: string;
  cancellationDate: string;
  serviceAccessUntil: string;
  hasCurrentServiceAccess: boolean;
  stripeCustomerId: string;
  stripeCustomerEmail: string;
  latestQualifyingPaidThrough: string;
  activeSlackUserId: string;
  activeSlackEmail: string;
  activeSlackDisplayName: string;
  slackIdentityState: SlackIdentityState;
  cityChannelId: string;
  cityChannelName: string;
  cityChannelMembership: ChannelMembershipState;
  allMembersChannelId: string;
  allMembersChannelMembership: ChannelMembershipState;
  resolverConfidence: "high" | "low" | "none";
  issues: MemberIssue[];
  highestSeverity: IssueSeverity | null;
  recommendedNextAction: string;
  /** True when this row is Stripe-only (no Airtable member). */
  stripeOnly: boolean;
};

export type IntegrationCheckStatus =
  | "healthy"
  | "warning"
  | "error"
  | "not_configured"
  | "not_checked";

export type IntegrationHealth = {
  name: string;
  status: IntegrationCheckStatus;
  configured: boolean;
  checked: boolean;
  message: string;
};

export type MemberHealthSummary = {
  scannedAt: string;
  referenceDate: string;
  totalAirtableMembers: number;
  withServiceAccess: number;
  fullyConnected: number;
  payingMissingSlack: number;
  payingStripeMissingAirtable: number;
  missingStripeCustomerId: number;
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  channelGaps: number;
  issuesByCode: Record<string, number>;
  issuesByCity: Record<string, number>;
  integrations: IntegrationHealth[];
  mode: string;
  partial: boolean;
  warnings: string[];
};

export type MemberHealthScanResult = {
  summary: MemberHealthSummary;
  members: MemberHealthRow[];
  /** Stripe customers with qualifying membership and no Airtable match. */
  orphanStripeCustomers: MemberHealthRow[];
};
