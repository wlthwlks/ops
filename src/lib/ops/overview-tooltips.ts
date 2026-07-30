/** Centralized overview tooltip copy — operational, not vague. */

export const OVERVIEW_KPI_TOOLTIPS = {
  serviceAccess:
    "Members who currently have access via Active+Paid or a non-expired Service access until date (shared hasServiceAccess rule). Sources: Airtable. Based on last scan. If high cancellations still appear here, check paid-through grace dates.",
  fullyConnected:
    "Service-eligible members with Stripe Customer ID linked, trusted Slack identity, city channel membership, and all-wlth-wlks membership when channel data was scanned. Sources: Airtable + Slack. Based on last scan. Gaps usually mean Slack or channel issues.",
  payingMissingSlack:
    "Service-eligible Airtable members with no trusted active Slack human user (primary or Slack Email). Sources: Airtable + Slack users.list. Based on last scan. Action: open Slack Access → Needs Slack and send joining email when live.",
  payingStripeMissingAirtable:
    "Stripe customers with qualifying paid membership invoices and no Airtable match. Not computed on every overview load (expensive). Usually 0 here until a billing CLI/scan. Never auto-created from the dashboard — use Make or historical CLI.",
  missingStripeCustomerId:
    "Service-eligible Airtable members whose Stripe Customer ID is blank. Sources: Airtable. Based on last scan. Action: Billing Integrity → Missing Stripe Links, then reconcile CLI for unique matches only.",
  criticalIssues:
    "Count of non-info issues classified critical (duplicates, Stripe ID conflicts, invalid access dates, paying Stripe missing Airtable, etc.). Sources: last member-health classification. Action: open Data Issues → Critical.",
  channelGaps:
    "Members missing city channel or all-wlth-wlks after a channel membership scan. 0 if channels were not scanned. Sources: Airtable channels + Slack conversations.members. Action: Slack Access → scan channels, then fix missing memberships.",
  failedOps24h:
    "Registry operations in Postgres op_runs with status failed in the last 24 hours. Sources: Postgres. Independent of member scan. Action: open Operations and inspect run logs.",
} as const;

export const OVERVIEW_FUNNEL_TOOLTIPS = {
  section:
    "How service-eligible members progress from Airtable eligibility through Stripe and Slack linkage. Drops between stages are identity or access gaps, not matching quality. Based on the last member-health scan (channel stages need an explicit channel scan).",
  serviceEligible:
    "Members passing hasServiceAccess (Active+Paid or valid Service access until). Airtable only.",
  inAirtable:
    "Total Airtable Members rows loaded in the scan (not only eligible). Larger than service-eligible when cancelled/inactive rows exist.",
  stripeLinked:
    "Service-eligible members with a non-blank Stripe Customer ID starting with cus_. Missing IDs drop out here.",
  slackResolved:
    "Service-eligible members matched to one active Slack human via primary email or Slack Email. Ambiguous/stale/missing identities drop out.",
  fullyConnected:
    "Eligible members with Stripe link, Slack identity, and (when scanned) both required channel memberships. Lowest stage when channel data is incomplete.",
} as const;

export const OVERVIEW_SECTION_TOOLTIPS = {
  criticalIssues:
    "Highest-severity actionable problems from the last scan. Click through to Data Issues. Informational conditions (e.g. access later than Stripe) are excluded.",
  integrationHealth:
    "Per-system status. Configured means env vars exist. Checked means this request probed the system. Healthy requires a successful check — not merely configured. Warning/error need attention; not_checked means skipped this load.",
  dataFreshness:
    "Timestamp of the scan powering these numbers. Stale data means counts may lag Airtable/Slack changes. Use Scan to refresh.",
  partialScan:
    "Some integrations failed or channel membership was not requested. Valid partial data is still shown; treat missing systems as unavailable, not zero problems.",
} as const;
