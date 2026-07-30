/**
 * Conservative Stripe Customer ID reconciliation helpers.
 * Automatic matches only when every strict rule passes.
 */

export type ReconcileMatchStatus =
  | "auto_match"
  | "already_has_customer_id"
  | "missing_airtable_email"
  | "invalid_airtable_email"
  | "duplicate_airtable_email"
  | "no_stripe_customer"
  | "multiple_stripe_customers"
  | "stripe_customer_already_assigned"
  | "no_paid_invoices"
  | "no_qualifying_membership_invoice"
  | "invalid_invoice_period"
  | "stripe_error"
  | "airtable_error"
  | "slack_email_only"
  | "record_changed_before_apply"
  | "email_changed_before_apply"
  | "stripe_customer_id_already_set"
  | "duplicate_email_detected_before_apply"
  | "stripe_customer_id_conflict_before_apply"
  | "record_missing_before_apply";

export type AirtableMemberCandidate = {
  recordId: string;
  name: string;
  email: string;
  normalizedEmail: string;
  slackEmail: string;
  existingStripeCustomerId: string;
  serviceAccessUntil: string;
};

export type StripeCustomerCandidate = {
  id: string;
  email: string;
  normalizedEmail: string;
  created: number;
  livemode: boolean;
};

export type ReconcileRow = {
  airtableRecordId: string;
  memberName: string;
  airtableEmail: string;
  slackEmail: string;
  existingStripeCustomerId: string;
  suggestedStripeCustomerId: string;
  stripeEmail: string;
  matchStatus: ReconcileMatchStatus;
  reason: string;
  stripeCustomerCountForEmail: number;
  airtableRecordCountForEmail: number;
  latestQualifyingPaidThrough: string;
  currentServiceAccessUntil: string;
  wouldUpdate: boolean;
  updated: boolean;
  candidateStripeCustomerIds: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize email: trim + lowercase only. No Gmail/dot/alias rewriting. */
export function normalizeEmailStrict(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const n = normalizeEmailStrict(email);
  if (!n) return false;
  return EMAIL_RE.test(n);
}

export function maskEmail(email: string): string {
  const n = email.trim();
  if (!n.includes("@")) return "***";
  const [local, domain] = n.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
}

export function parseReconcileArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const dryRun = !apply;
  let limit: number | undefined;
  let airtableRecordId: string | undefined;
  let email: string | undefined;
  let output = "tmp/stripe-customer-reconciliation.csv";

  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10);
    } else if (arg.startsWith("--airtable-record-id=")) {
      airtableRecordId = arg.slice("--airtable-record-id=".length).trim();
    } else if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length).trim();
    }
  }

  return { apply, dryRun, limit, airtableRecordId, email, output };
}

export function buildAssignedCustomerIds(
  members: Array<{ existingStripeCustomerId: string }>
): Set<string> {
  const set = new Set<string>();
  for (const m of members) {
    const id = m.existingStripeCustomerId.trim();
    if (id.startsWith("cus_")) set.add(id);
  }
  return set;
}

export function groupByNormalizedEmail<T extends { normalizedEmail: string }>(
  items: T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (!item.normalizedEmail) continue;
    const list = map.get(item.normalizedEmail) || [];
    list.push(item);
    map.set(item.normalizedEmail, list);
  }
  return map;
}

/**
 * Classify a single Airtable candidate against Stripe customers for that email
 * and billing validation result.
 */
export function classifyCandidate(input: {
  member: AirtableMemberCandidate;
  airtableRecordsForEmail: number;
  stripeCandidates: StripeCustomerCandidate[];
  assignedElsewhere: Set<string>;
  billing?: {
    ok: boolean;
    error?: string;
    hasPaidInvoices: boolean;
    hasQualifyingMembership: boolean;
    latestPaidThroughIso: string | null;
    periodValid: boolean;
  };
}): ReconcileRow {
  const { member, airtableRecordsForEmail, stripeCandidates, assignedElsewhere, billing } = input;

  const base = {
    airtableRecordId: member.recordId,
    memberName: member.name,
    airtableEmail: member.email,
    slackEmail: member.slackEmail,
    existingStripeCustomerId: member.existingStripeCustomerId,
    suggestedStripeCustomerId: "",
    stripeEmail: "",
    stripeCustomerCountForEmail: stripeCandidates.length,
    airtableRecordCountForEmail: airtableRecordsForEmail,
    latestQualifyingPaidThrough: billing?.latestPaidThroughIso ?? "",
    currentServiceAccessUntil: member.serviceAccessUntil,
    wouldUpdate: false,
    updated: false,
    candidateStripeCustomerIds: stripeCandidates.map((c) => c.id).join(";"),
  };

  if (member.existingStripeCustomerId.trim().startsWith("cus_")) {
    return {
      ...base,
      matchStatus: "already_has_customer_id",
      reason: "Stripe Customer ID already set",
    };
  }

  if (!member.email.trim() && member.slackEmail.trim()) {
    return {
      ...base,
      matchStatus: "slack_email_only",
      reason: "Primary email blank; Slack Email present — manual review only",
    };
  }

  if (!member.email.trim()) {
    return {
      ...base,
      matchStatus: "missing_airtable_email",
      reason: "Primary email is blank",
    };
  }

  if (!isValidEmail(member.email)) {
    return {
      ...base,
      matchStatus: "invalid_airtable_email",
      reason: "Primary email is malformed",
    };
  }

  if (airtableRecordsForEmail > 1) {
    return {
      ...base,
      matchStatus: "duplicate_airtable_email",
      reason: `Multiple Airtable records share email (${airtableRecordsForEmail})`,
    };
  }

  if (stripeCandidates.length === 0) {
    return {
      ...base,
      matchStatus: "no_stripe_customer",
      reason: "No non-deleted Stripe customer with this email",
    };
  }

  if (stripeCandidates.length > 1) {
    return {
      ...base,
      matchStatus: "multiple_stripe_customers",
      reason: `Multiple Stripe customers share email (${stripeCandidates.length})`,
      stripeEmail: stripeCandidates[0]?.email ?? "",
    };
  }

  const stripe = stripeCandidates[0];
  if (assignedElsewhere.has(stripe.id)) {
    return {
      ...base,
      suggestedStripeCustomerId: stripe.id,
      stripeEmail: stripe.email,
      matchStatus: "stripe_customer_already_assigned",
      reason: "Stripe customer ID already assigned to another Airtable record",
    };
  }

  if (!billing) {
    return {
      ...base,
      suggestedStripeCustomerId: stripe.id,
      stripeEmail: stripe.email,
      matchStatus: "stripe_error",
      reason: "Billing history not validated",
    };
  }

  if (!billing.ok) {
    return {
      ...base,
      suggestedStripeCustomerId: stripe.id,
      stripeEmail: stripe.email,
      matchStatus: "stripe_error",
      reason: billing.error || "Stripe error while validating billing history",
    };
  }

  if (!billing.hasPaidInvoices) {
    return {
      ...base,
      suggestedStripeCustomerId: stripe.id,
      stripeEmail: stripe.email,
      matchStatus: "no_paid_invoices",
      reason: "Stripe customer has no paid invoices",
    };
  }

  if (!billing.hasQualifyingMembership) {
    return {
      ...base,
      suggestedStripeCustomerId: stripe.id,
      stripeEmail: stripe.email,
      matchStatus: "no_qualifying_membership_invoice",
      reason: "No paid invoice with configured membership Price ID",
    };
  }

  if (!billing.periodValid || !billing.latestPaidThroughIso) {
    return {
      ...base,
      suggestedStripeCustomerId: stripe.id,
      stripeEmail: stripe.email,
      matchStatus: "invalid_invoice_period",
      reason: "Qualifying invoice line missing valid period.end",
    };
  }

  return {
    ...base,
    suggestedStripeCustomerId: stripe.id,
    stripeEmail: stripe.email,
    latestQualifyingPaidThrough: billing.latestPaidThroughIso,
    matchStatus: "auto_match",
    reason: "Unique email + unique Stripe customer + qualifying paid membership invoice",
    wouldUpdate: true,
  };
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function rowsToCsv(rows: ReconcileRow[]): string {
  const headers = [
    "airtableRecordId",
    "memberName",
    "airtableEmail",
    "slackEmail",
    "existingStripeCustomerId",
    "suggestedStripeCustomerId",
    "stripeEmail",
    "matchStatus",
    "reason",
    "stripeCustomerCountForEmail",
    "airtableRecordCountForEmail",
    "latestQualifyingPaidThrough",
    "currentServiceAccessUntil",
    "wouldUpdate",
    "updated",
    "candidateStripeCustomerIds",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.airtableRecordId,
        r.memberName,
        r.airtableEmail,
        r.slackEmail,
        r.existingStripeCustomerId,
        r.suggestedStripeCustomerId,
        r.stripeEmail,
        r.matchStatus,
        r.reason,
        String(r.stripeCustomerCountForEmail),
        String(r.airtableRecordCountForEmail),
        r.latestQualifyingPaidThrough,
        r.currentServiceAccessUntil,
        String(r.wouldUpdate),
        String(r.updated),
        r.candidateStripeCustomerIds,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export function isManualReviewStatus(status: ReconcileMatchStatus): boolean {
  return (
    status === "duplicate_airtable_email" ||
    status === "multiple_stripe_customers" ||
    status === "stripe_customer_already_assigned" ||
    status === "slack_email_only" ||
    status === "no_paid_invoices" ||
    status === "no_qualifying_membership_invoice" ||
    status === "invalid_invoice_period" ||
    status === "no_stripe_customer"
  );
}

/** Apply-time recheck before writing. */
export function canStillApply(input: {
  row: ReconcileRow;
  currentExistingId: string;
  assignedElsewhere: Set<string>;
  currentNormalizedEmail: string;
}): { ok: true } | { ok: false; status: ReconcileMatchStatus; reason: string } {
  const { row, currentExistingId, assignedElsewhere, currentNormalizedEmail } = input;
  if (currentExistingId.trim().startsWith("cus_")) {
    return {
      ok: false,
      status: "record_changed_before_apply",
      reason: "Record already has Stripe Customer ID",
    };
  }
  if (normalizeEmailStrict(row.airtableEmail) !== currentNormalizedEmail) {
    return {
      ok: false,
      status: "record_changed_before_apply",
      reason: "Airtable email changed before apply",
    };
  }
  if (assignedElsewhere.has(row.suggestedStripeCustomerId)) {
    return {
      ok: false,
      status: "record_changed_before_apply",
      reason: "Suggested Stripe customer became assigned elsewhere",
    };
  }
  if (row.matchStatus !== "auto_match" || !row.suggestedStripeCustomerId) {
    return {
      ok: false,
      status: "record_changed_before_apply",
      reason: "Row is not an auto_match",
    };
  }
  return { ok: true };
}
