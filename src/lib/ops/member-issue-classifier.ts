import type {
  IssueSeverity,
  MemberIssue,
  MemberIssueCode,
  MemberHealthRow,
  SlackIdentityState,
  ChannelMembershipState,
} from "@/lib/ops/member-health-types";
import { isValidEmail, normalizeEmailStrict } from "@/lib/billing/reconcile-stripe-customers";
import { hasServiceAccess } from "@/lib/introduction/service-access";

const ISSUE_META: Record<
  MemberIssueCode,
  Omit<MemberIssue, "code"> & { code?: MemberIssueCode }
> = {
  PAYING_STRIPE_CUSTOMER_MISSING_AIRTABLE: {
    severity: "critical",
    label: "Paying Stripe customer missing Airtable",
    explanation:
      "A Stripe customer has a qualifying paid membership invoice but no matching Airtable Members record.",
    recommendedAction:
      "Ensure Memberstack → Make created the member, or run the one-time historical CLI repair. Dashboard cannot create members.",
    systems: ["stripe", "airtable"],
  },
  DUPLICATE_AIRTABLE_EMAIL: {
    severity: "critical",
    label: "Duplicate Airtable email",
    explanation: "Multiple Airtable Members share the same primary email.",
    recommendedAction: "Merge or correct duplicate Airtable records before linking billing.",
    systems: ["airtable"],
  },
  MULTIPLE_STRIPE_CUSTOMERS_FOR_EMAIL: {
    severity: "critical",
    label: "Multiple Stripe customers for email",
    explanation: "More than one Stripe customer uses this email.",
    recommendedAction: "Manually pick the correct Stripe Customer ID in Airtable.",
    systems: ["stripe", "airtable"],
  },
  STRIPE_CUSTOMER_ID_CONFLICT: {
    severity: "critical",
    label: "Stripe Customer ID conflict",
    explanation: "Suggested Stripe identity conflicts with an existing assignment.",
    recommendedAction: "Review Airtable Stripe Customer ID and resolve manually.",
    systems: ["stripe", "airtable"],
  },
  STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS: {
    severity: "critical",
    label: "Stripe ID on multiple members",
    explanation: "The same Stripe Customer ID appears on more than one Airtable record.",
    recommendedAction: "Keep the ID on one member and clear it from the others.",
    systems: ["airtable", "stripe"],
  },
  INVALID_SERVICE_ACCESS_DATE: {
    severity: "critical",
    label: "Invalid Service access until",
    explanation: "Service access until is set but cannot be parsed as a date.",
    recommendedAction: "Fix the date field in Airtable.",
    systems: ["airtable"],
  },
  ACTIVE_PAID_MEMBER_WITHOUT_QUALIFYING_STRIPE_PAYMENT: {
    severity: "high",
    label: "Active/Paid without Stripe proof",
    explanation:
      "Member is Active+Paid but no qualifying Stripe paid-through was found (when billing scan ran).",
    recommendedAction: "Verify Payment/Membership fields and Stripe linkage.",
    systems: ["airtable", "stripe"],
  },
  SERVICE_ELIGIBLE_MEMBER_NOT_IN_SLACK: {
    severity: "high",
    label: "Service-eligible member not in Slack",
    explanation: "Member has service access but no trusted active Slack identity.",
    recommendedAction: "Send Slack joining email or resolve Slack Email.",
    systems: ["slack", "airtable"],
  },
  AIRTABLE_SLACK_EMAIL_POINTS_TO_NO_ACTIVE_USER: {
    severity: "high",
    label: "Stale Slack Email",
    explanation: "Airtable Slack Email does not match any active Slack user.",
    recommendedAction: "Clear or correct Slack Email; do not assume populated values are valid.",
    systems: ["slack", "airtable"],
  },
  ACTIVE_MEMBER_HAS_DEACTIVATED_SLACK_ACCOUNT: {
    severity: "high",
    label: "Deactivated Slack account",
    explanation: "Matched Slack user is deleted or deactivated.",
    recommendedAction: "Ask the member to rejoin Slack with an active account.",
    systems: ["slack"],
  },
  SLACK_IDENTITY_MATCH_AMBIGUOUS: {
    severity: "high",
    label: "Ambiguous Slack match",
    explanation: "Multiple Slack users could match this member by name.",
    recommendedAction: "Operator must choose the correct Slack user before writing Slack Email.",
    systems: ["slack", "airtable"],
  },
  MEMBER_NOT_IN_CITY_CHANNEL: {
    severity: "high",
    label: "Missing city channel",
    explanation: "Active Slack user is not in their city's Slack channel.",
    recommendedAction: "Send channel join reminder or add them in Slack.",
    systems: ["slack"],
  },
  MEMBER_NOT_IN_ALL_MEMBERS_CHANNEL: {
    severity: "high",
    label: "Missing all-wlth-wlks",
    explanation: "Active Slack user is not in the all-members channel.",
    recommendedAction: "Ask them to join all-wlth-wlks.",
    systems: ["slack"],
  },
  CITY_CHANNEL_NOT_CONFIGURED: {
    severity: "high",
    label: "City channel not configured",
    explanation:
      "Member city has no usable Active Slack channel (missing City→channel link or Active channel missing Slack Channel ID). Paused/Closed channels are not treated as this error.",
    recommendedAction:
      "Link Cities to Slack channels and ensure Active channels have a Slack Channel ID. Run npm run airtable:repair-city-relations -- --audit.",
    systems: ["config", "airtable"],
  },
  MEMBER_CITY_MISSING: {
    severity: "medium",
    label: "City missing",
    explanation:
      "Service-eligible member has no city (legacy City blank and no City relation link).",
    recommendedAction:
      "Set legacy City or City relation on the Member. Run city-relation repair after mapping.",
    systems: ["airtable"],
  },
  AIRTABLE_MEMBER_MISSING_STRIPE_CUSTOMER_ID: {
    severity: "medium",
    label: "Missing Stripe Customer ID",
    explanation: "Service-eligible member has no Stripe Customer ID.",
    recommendedAction: "Run billing reconcile dry-run; apply only unique auto matches.",
    systems: ["airtable", "stripe"],
  },
  PRIMARY_EMAIL_MISSING: {
    severity: "medium",
    label: "Primary email missing",
    explanation: "Member has no primary email.",
    recommendedAction: "Add primary email in Airtable (required for billing and outreach).",
    systems: ["airtable"],
  },
  PRIMARY_EMAIL_INVALID: {
    severity: "medium",
    label: "Primary email invalid",
    explanation: "Primary email is malformed.",
    recommendedAction: "Fix the email format in Airtable.",
    systems: ["airtable"],
  },
  SLACK_EMAIL_MISSING_BUT_PRIMARY_EMAIL_MATCHES: {
    severity: "info",
    label: "Slack Email optional",
    explanation:
      "Primary email already matches an active Slack user; blank Slack Email is not an error.",
    recommendedAction: "No action required. Optionally store Slack Email for clarity.",
    systems: ["slack", "airtable"],
  },
  SERVICE_ACCESS_DATE_BEHIND_STRIPE: {
    severity: "medium",
    label: "Service access behind Stripe",
    explanation: "Airtable Service access until is earlier than Stripe paid-through.",
    recommendedAction: "Run service-access backfill or wait for invoice.paid webhook.",
    systems: ["airtable", "stripe"],
  },
  AIRTABLE_PAYMENT_STATUS_DISAGREES_WITH_STRIPE: {
    severity: "medium",
    label: "Payment status disagrees with Stripe",
    explanation: "Airtable Payment/Membership may not reflect Stripe billing state.",
    recommendedAction: "Review Payment and Membership fields against Stripe.",
    systems: ["airtable", "stripe"],
  },
  FULLY_CONNECTED: {
    severity: "info",
    label: "Fully connected",
    explanation: "Member has service access, Stripe link, Slack identity, and channel memberships.",
    recommendedAction: "No action required.",
    systems: ["airtable", "stripe", "slack"],
  },
  CANCELLED_WITH_VALID_SERVICE_ACCESS: {
    severity: "info",
    label: "Cancelled with valid access",
    explanation: "Membership is not Active/Paid but Service access until is still valid.",
    recommendedAction: "Expected during paid-through grace period.",
    systems: ["airtable"],
  },
  SERVICE_ACCESS_LATER_THAN_STRIPE: {
    severity: "info",
    label: "Access later than Stripe",
    explanation:
      "Airtable Service access until is later than Stripe paid-through (monotonic / grandfathered).",
    recommendedAction: "Not an error. Do not shorten the date.",
    systems: ["airtable", "stripe"],
  },
  EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE: {
    severity: "high",
    label: "Expired member still in Slack",
    explanation:
      "The member’s paid service period has ended, but their active Slack account still has WLTH WLKS access.",
    recommendedAction: "Review and remove the member from WLTH WLKS Slack access.",
    systems: ["slack", "airtable"],
  },
};

export function makeIssue(code: MemberIssueCode): MemberIssue {
  const meta = ISSUE_META[code];
  return { code, ...meta };
}

export function severityRank(s: IssueSeverity | null): number {
  if (s === "critical") return 0;
  if (s === "high") return 1;
  if (s === "medium") return 2;
  if (s === "info") return 3;
  return 9;
}

export function highestSeverity(issues: MemberIssue[]): IssueSeverity | null {
  if (issues.length === 0) return null;
  return [...issues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]
    .severity;
}

export type ClassifyInput = {
  airtableRecordId: string | null;
  name: string;
  primaryEmail: string;
  slackEmail: string;
  city: string;
  membership: string;
  payment: string;
  serviceAccessUntil: string;
  stripeCustomerId: string;
  stripeCustomerEmail?: string;
  latestQualifyingPaidThrough?: string;
  /** Count of Airtable records sharing normalized primary email. */
  airtableEmailCount: number;
  /** Count of Airtable records sharing this Stripe Customer ID. */
  stripeIdAirtableCount: number;
  slackIdentityState: SlackIdentityState;
  cityChannelMembership: ChannelMembershipState;
  allMembersChannelMembership: ChannelMembershipState;
  cityChannelConfigured: boolean;
  referenceDate: Date;
  /** When true, Stripe billing details were loaded for this member. */
  billingChecked?: boolean;
  hasQualifyingStripePayment?: boolean;
  stripeOnly?: boolean;
};

/**
 * Pure classifier — unit-testable, no I/O.
 */
export function classifyMemberHealth(input: ClassifyInput): {
  issues: MemberIssue[];
  hasCurrentServiceAccess: boolean;
  highestSeverity: IssueSeverity | null;
  recommendedNextAction: string;
} {
  const issues: MemberIssue[] = [];
  const access = hasServiceAccess(
    input.membership,
    input.payment,
    input.serviceAccessUntil || null,
    input.referenceDate
  );

  if (input.stripeOnly) {
    issues.push(makeIssue("PAYING_STRIPE_CUSTOMER_MISSING_AIRTABLE"));
    return {
      issues,
      hasCurrentServiceAccess: true,
      highestSeverity: highestSeverity(issues),
      recommendedNextAction: issues[0].recommendedAction,
    };
  }

  if (input.serviceAccessUntil) {
    const d = new Date(input.serviceAccessUntil);
    if (Number.isNaN(d.getTime())) {
      issues.push(makeIssue("INVALID_SERVICE_ACCESS_DATE"));
    }
  }

  if (!input.primaryEmail.trim()) {
    issues.push(makeIssue("PRIMARY_EMAIL_MISSING"));
  } else if (!isValidEmail(input.primaryEmail)) {
    issues.push(makeIssue("PRIMARY_EMAIL_INVALID"));
  }

  if (input.airtableEmailCount > 1 && input.primaryEmail.trim()) {
    issues.push(makeIssue("DUPLICATE_AIRTABLE_EMAIL"));
  }

  if (
    input.stripeCustomerId.startsWith("cus_") &&
    input.stripeIdAirtableCount > 1
  ) {
    issues.push(makeIssue("STRIPE_CUSTOMER_ASSIGNED_TO_MULTIPLE_AIRTABLE_RECORDS"));
  }

  if (access && !input.stripeCustomerId.startsWith("cus_")) {
    issues.push(makeIssue("AIRTABLE_MEMBER_MISSING_STRIPE_CUSTOMER_ID"));
  }

  if (
    access &&
    input.billingChecked &&
    input.hasQualifyingStripePayment === false &&
    input.membership === "Active" &&
    input.payment === "Paid"
  ) {
    issues.push(makeIssue("ACTIVE_PAID_MEMBER_WITHOUT_QUALIFYING_STRIPE_PAYMENT"));
  }

  if (input.latestQualifyingPaidThrough && input.serviceAccessUntil) {
    const stripeEnd = new Date(input.latestQualifyingPaidThrough);
    const atEnd = new Date(input.serviceAccessUntil);
    if (!Number.isNaN(stripeEnd.getTime()) && !Number.isNaN(atEnd.getTime())) {
      if (atEnd.getTime() < stripeEnd.getTime()) {
        issues.push(makeIssue("SERVICE_ACCESS_DATE_BEHIND_STRIPE"));
      } else if (atEnd.getTime() > stripeEnd.getTime()) {
        issues.push(makeIssue("SERVICE_ACCESS_LATER_THAN_STRIPE"));
      }
    }
  }

  if (
    access &&
    (input.membership !== "Active" || input.payment !== "Paid") &&
    input.serviceAccessUntil
  ) {
    issues.push(makeIssue("CANCELLED_WITH_VALID_SERVICE_ACCESS"));
  }

  if (access) {
    if (!input.city.trim()) {
      issues.push(makeIssue("MEMBER_CITY_MISSING"));
    } else if (!input.cityChannelConfigured) {
      issues.push(makeIssue("CITY_CHANNEL_NOT_CONFIGURED"));
    }

    if (input.slackIdentityState === "not_found") {
      issues.push(makeIssue("SERVICE_ELIGIBLE_MEMBER_NOT_IN_SLACK"));
    } else if (input.slackIdentityState === "stale_slack_email") {
      issues.push(makeIssue("AIRTABLE_SLACK_EMAIL_POINTS_TO_NO_ACTIVE_USER"));
    } else if (input.slackIdentityState === "deactivated") {
      issues.push(makeIssue("ACTIVE_MEMBER_HAS_DEACTIVATED_SLACK_ACCOUNT"));
    } else if (input.slackIdentityState === "ambiguous") {
      issues.push(makeIssue("SLACK_IDENTITY_MATCH_AMBIGUOUS"));
    } else if (input.slackIdentityState === "matched_primary_email" && !input.slackEmail.trim()) {
      issues.push(makeIssue("SLACK_EMAIL_MISSING_BUT_PRIMARY_EMAIL_MATCHES"));
    }

    if (
      input.slackIdentityState === "matched_primary_email" ||
      input.slackIdentityState === "matched_slack_email"
    ) {
      if (input.cityChannelMembership === "not_member") {
        issues.push(makeIssue("MEMBER_NOT_IN_CITY_CHANNEL"));
      }
      if (input.allMembersChannelMembership === "not_member") {
        issues.push(makeIssue("MEMBER_NOT_IN_ALL_MEMBERS_CHANNEL"));
      }
    }
  } else {
    // Expired cancelled/inactive with valid past Service access until + active Slack
    const untilRaw = input.serviceAccessUntil?.trim() || "";
    const untilDate = untilRaw ? new Date(untilRaw) : null;
    const untilValid = untilDate && !Number.isNaN(untilDate.getTime());
    const untilExpired = untilValid && untilDate! < input.referenceDate;
    const isActivePaid = input.membership === "Active" && input.payment === "Paid";
    const activeSlack =
      input.slackIdentityState === "matched_primary_email" ||
      input.slackIdentityState === "matched_slack_email";

    if (!isActivePaid && untilExpired && activeSlack) {
      const places: string[] = ["Still in workspace"];
      if (input.allMembersChannelMembership === "member") {
        places.push("Still in all-wlth-wlks");
      }
      if (input.cityChannelMembership === "member") {
        places.push("Still in city channel");
      }
      if (
        input.allMembersChannelMembership === "member" &&
        input.cityChannelMembership === "member"
      ) {
        places.push("Still in multiple configured channels");
      }
      const issue = makeIssue("EXPIRED_MEMBER_STILL_IN_SLACK_WORKSPACE");
      issue.explanation = `${issue.explanation} (${places.join("; ")}).`;
      issues.push(issue);
    }
  }

  const actionable = issues.filter((i) => i.severity !== "info");
  if (
    access &&
    actionable.length === 0 &&
    input.stripeCustomerId.startsWith("cus_") &&
    (input.slackIdentityState === "matched_primary_email" ||
      input.slackIdentityState === "matched_slack_email") &&
    input.cityChannelMembership === "member" &&
    input.allMembersChannelMembership === "member"
  ) {
    issues.push(makeIssue("FULLY_CONNECTED"));
  }

  const hs = highestSeverity(issues);
  const next =
    issues
      .filter((i) => i.severity !== "info")
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]
      ?.recommendedAction ||
    issues[0]?.recommendedAction ||
    "No action required";

  return {
    issues,
    hasCurrentServiceAccess: access,
    highestSeverity: hs,
    recommendedNextAction: next,
  };
}

export function normalizeMemberEmail(email: string): string {
  return normalizeEmailStrict(email);
}

/** Build a partial MemberHealthRow shell then attach classification. */
export function buildMemberHealthRow(
  base: Omit<
    MemberHealthRow,
    "issues" | "highestSeverity" | "recommendedNextAction" | "hasCurrentServiceAccess"
  >,
  classify: ClassifyInput
): MemberHealthRow {
  const result = classifyMemberHealth(classify);
  return {
    ...base,
    hasCurrentServiceAccess: result.hasCurrentServiceAccess,
    issues: result.issues,
    highestSeverity: result.highestSeverity,
    recommendedNextAction: result.recommendedNextAction,
  };
}
