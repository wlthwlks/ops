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
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
  CANCEL_AT_PERIOD_END_FIELD,
  CANCELLATION_EFFECTIVE_AT_FIELD,
} from "@/lib/billing/service-access-sync";
import {
  listActiveMembershipSubscriptions,
  repairActiveSubscription,
  type ActiveMembershipSubscription,
} from "@/lib/billing/historical-stripe-member-repair";
import {
  calculateStripeEntitlement,
  type StripeInvoiceListClient,
} from "@/lib/billing/stripe-entitlement";
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
  /** Qualifying Stripe memberships (one best sub per customer) — reused by repair. */
  qualifyingMemberships: ActiveMembershipSubscription[];
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
    qualifyingMemberships: memberships,
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

export type ParityExtraFixAction = "corrected" | "cleared" | "linked" | "skipped";

export type ParityExtraFix = {
  airtableRecordId: string;
  action: ParityExtraFixAction;
  reason: string;
};

export type ParityExtrasRepairResult = {
  corrected: number;
  cleared: number;
  linked: number;
  skipped: number;
  /** corrected + cleared + linked */
  fixed: number;
  failed: Array<{ airtableRecordId: string; reason: string }>;
  details: ParityExtraFix[];
};

function normalizeEmailForIndex(email: string): string {
  return (email || "").trim().toLowerCase();
}

/**
 * Corrective extras repair — keeps Airtable future access aligned with the
 * Stripe allowlisted-price census by REVERSING the drift that the monotonic
 * invoice/webhook sync can never produce (it only extends access):
 *
 *   - cus_id_not_in_qualifying_set: compute Stripe entitlement for the stored
 *     customer id. Write the authoritative paid-through date (reduction allowed)
 *     when Stripe has one; clear the date when Stripe shows no qualifying
 *     membership at all. Mirrors `scripts/apply-future-access-parity.ts`.
 *   - no_stripe_customer_id: link via unique primary email to a qualifying
 *     membership (same path as hole repair); clear when no qualifying match.
 *   - duplicate_airtable_record: keep ONE future-access row per customer id
 *     (prefer the row whose email matches the Stripe customer email, else the
 *     latest access date) and clear the others.
 *
 * Every write re-reads the record first and skips when it changed since the
 * parity scan. Writes are batched; failures are reported, never thrown.
 */
export async function repairParityExtras(input: {
  stripe: ParityStripeClient;
  airtable: AirtableClient;
  extras: ParityExtraRow[];
  qualifyingMemberships: ActiveMembershipSubscription[];
  membershipPriceIds: Set<string>;
  maxExtras?: number;
}): Promise<ParityExtrasRepairResult> {
  const { stripe, airtable, membershipPriceIds, extras, qualifyingMemberships } = input;
  const maxExtras = Math.min(Math.max(input.maxExtras ?? 50, 1), 1000);

  const emailIndex = new Map<string, ActiveMembershipSubscription[]>();
  for (const m of qualifyingMemberships) {
    const email = normalizeEmailForIndex(
      typeof m.customer?.email === "string" ? m.customer.email : ""
    );
    if (!email) continue;
    const list = emailIndex.get(email) || [];
    list.push(m);
    emailIndex.set(email, list);
  }

  // For duplicate rows: decide which single row keeps future access per cus id.
  const keeperByCus = new Map<string, string>();
  const dupGroups = new Map<string, ParityExtraRow[]>();
  for (const e of extras.slice(0, maxExtras)) {
    if (e.reason !== "duplicate_airtable_record" || !e.stripeCustomerId) continue;
    const group = dupGroups.get(e.stripeCustomerId) || [];
    group.push(e);
    dupGroups.set(e.stripeCustomerId, group);
  }
  for (const [cus, group] of dupGroups) {
    const member = qualifyingMemberships.find((m) => m.stripeCustomerId === cus);
    const memberEmail = normalizeEmailForIndex(
      typeof member?.customer?.email === "string" ? member.customer.email : ""
    );
    const keeper = [...group]
      .sort((a, b) => {
        const aMatch = memberEmail && normalizeEmailForIndex(a.email) === memberEmail ? 1 : 0;
        const bMatch = memberEmail && normalizeEmailForIndex(b.email) === memberEmail ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        const aMs = new Date(a.accessUntil).getTime();
        const bMs = new Date(b.accessUntil).getTime();
        return (Number.isNaN(bMs) ? 0 : bMs) - (Number.isNaN(aMs) ? 0 : aMs);
      })[0];
    keeperByCus.set(cus, keeper.airtableRecordId);
  }

  const patches: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const details: ParityExtraFix[] = [];
  const failed: Array<{ airtableRecordId: string; reason: string }> = [];
  let corrected = 0;
  let cleared = 0;
  let linked = 0;
  let skipped = 0;

  for (const extra of extras.slice(0, maxExtras)) {
    try {
      const record = await airtable.getRecord(MEMBERS_TABLE, extra.airtableRecordId);
      const currentAccess = fieldStr(record.fields, SERVICE_ACCESS_FIELD);
      const currentCus = fieldStr(record.fields, STRIPE_CUSTOMER_ID_FIELD);
      if (currentAccess !== extra.accessUntil || currentCus !== extra.stripeCustomerId) {
        skipped++;
        details.push({
          airtableRecordId: extra.airtableRecordId,
          action: "skipped",
          reason: "Record changed since parity scan — skipped",
        });
        continue;
      }

      if (extra.reason === "duplicate_airtable_record") {
        if (keeperByCus.get(extra.stripeCustomerId) === extra.airtableRecordId) {
          skipped++;
          details.push({
            airtableRecordId: extra.airtableRecordId,
            action: "skipped",
            reason: "Kept one future-access row for duplicate customer id",
          });
        } else {
          patches.push({
            id: extra.airtableRecordId,
            fields: { [SERVICE_ACCESS_FIELD]: null },
          });
          cleared++;
          details.push({
            airtableRecordId: extra.airtableRecordId,
            action: "cleared",
            reason: "Duplicate customer id — cleared extra future access",
          });
        }
        continue;
      }

      if (extra.reason === "no_stripe_customer_id") {
        const email = normalizeEmailForIndex(extra.email);
        const matches = email ? emailIndex.get(email) || [] : [];
        if (matches.length === 1) {
          const result = await repairActiveSubscription({
            airtable,
            customer: matches[0].customer,
            membership: matches[0],
            canLink: true,
            canCreate: false,
            dryRun: false,
          });
          if (result.action === "error") {
            throw new Error(result.reason);
          }
          if (
            result.action === "linked_and_updated" ||
            result.action === "updated_access" ||
            result.action === "already_up_to_date"
          ) {
            linked++;
            details.push({
              airtableRecordId: extra.airtableRecordId,
              action: "linked",
              reason: "Linked via unique primary email to qualifying membership",
            });
          } else {
            skipped++;
            details.push({
              airtableRecordId: extra.airtableRecordId,
              action: "skipped",
              reason: `${result.action}: ${result.reason}`,
            });
          }
        } else {
          patches.push({
            id: extra.airtableRecordId,
            fields: { [SERVICE_ACCESS_FIELD]: null },
          });
          cleared++;
          details.push({
            airtableRecordId: extra.airtableRecordId,
            action: "cleared",
            reason:
              matches.length > 1
                ? "Ambiguous email match — cleared unsupported future access"
                : "No qualifying Stripe membership for email — cleared unsupported future access",
          });
        }
        continue;
      }

      // cus_id_not_in_qualifying_set — Stripe is the source of truth.
      if (!extra.stripeCustomerId.startsWith("cus_")) {
        skipped++;
        details.push({
          airtableRecordId: extra.airtableRecordId,
          action: "skipped",
          reason: "Malformed Stripe Customer ID — left for manual review",
        });
        continue;
      }
      const entitlement = await calculateStripeEntitlement({
        stripe: stripe as unknown as StripeInvoiceListClient,
        stripeCustomerId: extra.stripeCustomerId,
        membershipPriceIds,
        includeSubscriptions: true,
      });

      const fields: Record<string, unknown> = {
        [SERVICE_ACCESS_FIELD]: entitlement.paidThroughIso ?? null,
      };
      if (entitlement.primarySubscription?.status) {
        fields[STRIPE_SUBSCRIPTION_STATUS_FIELD] = entitlement.primarySubscription.status;
      }
      if (entitlement.primarySubscription) {
        fields[CANCEL_AT_PERIOD_END_FIELD] =
          entitlement.primarySubscription.cancelAtPeriodEnd;
        if (
          entitlement.cancellationKind !== "none" &&
          entitlement.effectiveCancellationUnix != null
        ) {
          fields[CANCELLATION_EFFECTIVE_AT_FIELD] = new Date(
            entitlement.effectiveCancellationUnix * 1000
          ).toISOString();
        }
      }

      patches.push({ id: extra.airtableRecordId, fields });
      if (entitlement.paidThroughIso) {
        corrected++;
        details.push({
          airtableRecordId: extra.airtableRecordId,
          action: "corrected",
          reason: `Service access until corrected to Stripe paid-through ${entitlement.paidThroughIso}`,
        });
      } else {
        cleared++;
        details.push({
          airtableRecordId: extra.airtableRecordId,
          action: "cleared",
          reason: "No qualifying Stripe entitlement — cleared future access",
        });
      }
    } catch (e) {
      failed.push({
        airtableRecordId: extra.airtableRecordId,
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }

  if (patches.length > 0) {
    await airtable.updateRecordsBatched(MEMBERS_TABLE, patches);
  }

  return {
    corrected,
    cleared,
    linked,
    skipped,
    fixed: corrected + cleared + linked,
    failed,
    details,
  };
}
