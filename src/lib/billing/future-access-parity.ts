/**
 * Future-access parity computation shared by:
 *   - scripts/audit-future-access-parity.ts (CLI report)
 *   - src/app/api/cron/future-access-parity/route.ts (daily safety-net cron)
 *
 * Definitions (match the audit CLI and the repair script's parity report):
 *   - Airtable future access  = MEMBERS rows with Service access until > today
 *   - Stripe qualifying       = active+trialing subscriptions whose items
 *     contain an allowlisted (listed) price_ id, one best sub per customer
 *   - extras                  = future-access rows whose Stripe Customer ID is
 *     missing or not in the qualifying set, plus duplicate rows sharing a
 *     qualifying customer id
 *   - holes                   = qualifying Stripe memberships whose customer
 *     has NO future-access Airtable row (paying member at risk of lapsed access)
 *
 * Pure read-only helpers — never write.
 */
import type { AirtableClient } from "@/lib/integrations/airtable";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  PAYMENT_FIELD,
  MEMBERSHIP_FIELD,
} from "@/lib/billing/service-access-sync";
import {
  listActiveMembershipSubscriptions,
  repairActiveSubscription,
  type ActiveMembershipSubscription,
} from "@/lib/billing/historical-stripe-member-repair";
import { PRIMARY_EMAIL_FIELD } from "@/lib/billing/webhook-invoice-sync";

export type ParityExtraReason =
  | "cus_id_not_in_qualifying_set"
  | "no_stripe_customer_id"
  | "duplicate_airtable_record";

export type ParityExtraRow = {
  airtableRecordId: string;
  email: string;
  name: string;
  stripeCustomerId: string;
  accessUntil: string;
  payment: string;
  membership: string;
  reason: ParityExtraReason;
};

export type ParityHole = {
  membership: ActiveMembershipSubscription;
  email: string;
  currentPeriodEndIso: string;
};

export type FutureAccessParity = {
  airtableFutureAccess: number;
  stripeQualifying: number;
  delta: number;
  extras: ParityExtraRow[];
  holes: ParityHole[];
  duplicates: Array<{ stripeCustomerId: string; count: number }>;
};

export function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return v == null ? "" : String(v).trim();
}

const PARITY_READ_FIELDS = [
  PRIMARY_EMAIL_FIELD,
  "Name",
  STRIPE_CUSTOMER_ID_FIELD,
  SERVICE_ACCESS_FIELD,
  PAYMENT_FIELD,
  MEMBERSHIP_FIELD,
];

/** Minimal Stripe surface used by the parity helpers (tests may pass partial mocks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParityStripeClient = any;

export async function computeFutureAccessParity(input: {
  stripe: ParityStripeClient;
  airtable: AirtableClient;
  membershipPriceIds: Set<string>;
  now?: Date;
}): Promise<FutureAccessParity> {
  const { stripe, airtable, membershipPriceIds } = input;
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);

  const memberships = await listActiveMembershipSubscriptions(stripe, membershipPriceIds);
  const qualifyingCusIds = new Set(memberships.map((m) => m.stripeCustomerId));

  const records = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `IS_AFTER({${SERVICE_ACCESS_FIELD}}, "${date}")`,
    fields: PARITY_READ_FIELDS,
  });

  const cusIdCounts = new Map<string, number>();
  for (const r of records) {
    const cus = fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD);
    if (!cus) continue;
    cusIdCounts.set(cus, (cusIdCounts.get(cus) || 0) + 1);
  }
  const duplicates = [...cusIdCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([stripeCustomerId, count]) => ({ stripeCustomerId, count }));

  const extras: ParityExtraRow[] = [];
  for (const r of records) {
    const cus = fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD);
    let reason: ParityExtraReason | null = null;
    if (!cus) reason = "no_stripe_customer_id";
    else if (!qualifyingCusIds.has(cus)) reason = "cus_id_not_in_qualifying_set";
    else if ((cusIdCounts.get(cus) || 0) > 1) reason = "duplicate_airtable_record";
    if (!reason) continue;
    extras.push({
      airtableRecordId: r.id,
      email: fieldStr(r.fields, PRIMARY_EMAIL_FIELD),
      name: fieldStr(r.fields, "Name"),
      stripeCustomerId: cus,
      accessUntil: fieldStr(r.fields, SERVICE_ACCESS_FIELD),
      payment: fieldStr(r.fields, PAYMENT_FIELD),
      membership: fieldStr(r.fields, MEMBERSHIP_FIELD),
      reason,
    });
  }

  const futureCusIds = new Set(
    records.map((r) => fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD)).filter(Boolean)
  );
  const holes: ParityHole[] = memberships
    .filter((m) => !futureCusIds.has(m.stripeCustomerId))
    .map((m) => ({
      membership: m,
      email: typeof m.customer?.email === "string" ? m.customer.email : "",
      currentPeriodEndIso: m.currentPeriodEndUnix
        ? new Date(m.currentPeriodEndUnix * 1000).toISOString()
        : "",
    }));

  return {
    airtableFutureAccess: records.length,
    stripeQualifying: memberships.length,
    delta: records.length - memberships.length,
    extras,
    holes,
    duplicates,
  };
}

/**
 * Monotonic hole repair: for each hole, run the same reconcile used by
 * `airtable:historical-stripe-repair -- --subscriptions --apply --create-missing`.
 * Never shortens access. Creates missing members (historical CLI policy).
 */
export async function repairParityHoles(input: {
  airtable: AirtableClient;
  holes: ParityHole[];
  maxHoles?: number;
}): Promise<{ fixed: number; failed: Array<{ email: string; reason: string }> }> {
  const { airtable, holes } = input;
  const maxHoles = Math.min(Math.max(input.maxHoles ?? 100, 1), 1000);
  let fixed = 0;
  const failed: Array<{ email: string; reason: string }> = [];

  for (const hole of holes.slice(0, maxHoles)) {
    try {
      const result = await repairActiveSubscription({
        airtable,
        customer: hole.membership.customer,
        membership: hole.membership,
        canLink: true,
        canCreate: true,
        dryRun: false,
      });
      if (result.action === "error") {
        failed.push({ email: hole.email, reason: result.reason });
      } else {
        fixed++;
      }
    } catch (e) {
      failed.push({
        email: hole.email,
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }

  return { fixed, failed };
}
