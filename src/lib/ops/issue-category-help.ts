export const ISSUE_CATEGORY_HELP: Record<string, string> = {
  all: "All actionable and informational data conditions matching the current filters.",
  critical:
    "Conflicts that can cause billing or identity data to be attached to the wrong member, including duplicates and Stripe ID conflicts.",
  billing:
    "Stripe linkage, payment evidence, duplicate billing identity and paid-through inconsistencies.",
  slack: "Members who cannot be linked to a trusted active Slack account.",
  channel:
    "Members missing required channel membership or cities without usable active channel configuration.",
  identity:
    "Missing, ambiguous, stale or conflicting identity information between Airtable, Stripe and Slack.",
  service_access:
    "Invalid, expired, behind or intentionally extended Service access until values.",
};
