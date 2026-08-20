/**
 * Always-on Stripe pause-collection sync → Airtable.
 *
 * Pause collection (indefinite or scheduled) makes the member INACTIVE in
 * Airtable immediately:
 *   - Stripe subscription status = "paused"
 *   - Billing pause until          = resume date (blank = indefinite)
 *   - Service access until         = now (member no longer looks active)
 *   - Membership                   = "Paused" (Payment is left "Paid" —
 *     pausing is not a payment failure)
 *
 * On resume the reverse happens: Membership back to "Active", status restored,
 * and Service access until restored from the Stripe period end when it is
 * still in the future. If the period lapsed during a long pause, access is
 * left to the resume charge's invoice.paid webhook (always-on).
 *
 * This module is deliberately NOT gated by NEW_STRIPE_WEBHOOKS_ENABLED or
 * MAKE_SHADOW_MODE — pausing is a native Stripe billing state and must sync
 * regardless of the forms cutover flags. Matches by exact Stripe Customer ID
 * only; never creates members, never email-matches.
 */
import type Stripe from "stripe";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  MEMBERS_TABLE,
  MEMBERSHIP_FIELD,
  SERVICE_ACCESS_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
  billingValueChanged,
  findAirtableMembersByStripeCustomerId,
  getStripeCustomerId,
} from "@/lib/billing/service-access-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";

export type PauseSyncStatus = "updated" | "already_up_to_date" | "no_airtable_member";

export interface PauseSyncResult {
  status: PauseSyncStatus;
  stripeCustomerId: string;
  airtableRecordsMatched: number;
  airtableRecordsUpdated: number;
  duplicateAirtableRecords: boolean;
  reason: string;
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

/** Resume date from pause_collection, or null when paused indefinitely. */
export function pauseResumeDateFromSubscription(sub: Stripe.Subscription): string | null {
  const pauseCollection = (sub.pause_collection || null) as
    | { resumes_at?: number | null }
    | null;
  const resumesAt = pauseCollection?.resumes_at;
  return typeof resumesAt === "number" && resumesAt > 0
    ? new Date(resumesAt * 1000).toISOString().slice(0, 10)
    : null;
}

export interface PauseTransitionInput {
  /** Subscription status from the event payload. */
  status: string | null | undefined;
  /** Subscription pause_collection from the event payload. */
  pauseCollection: unknown;
  /** previous_attributes.pause_collection (only present when it changed). */
  prevPauseCollection: unknown;
  /** previous_attributes.status (only present when it changed). */
  prevStatus: string | null | undefined;
  /** Stripe event type. */
  eventType: string;
}

/**
 * Classify a subscription webhook event as a pause or resume transition.
 *
 * IMPORTANT: Stripe pause collection does NOT change the subscription status —
 * it stays "active" and the pause is only visible as `pause_collection` on the
 * subscription object (resumes_at null = indefinite). The dedicated
 * customer.subscription.paused/resumed events belong to other flows (e.g.
 * subscription schedules that DO set status "paused"), so we support both.
 *
 * Returns "paused", "resumed", or null (no pause transition — caller should
 * fall through to normal handling).
 */
export function classifyPauseTransition(input: PauseTransitionInput): "paused" | "resumed" | null {
  const hasPauseCollection = input.pauseCollection != null;
  const hadPauseCollection = input.prevPauseCollection != null;
  const statusLower = (input.status ?? "").trim().toLowerCase();

  if (statusLower === "paused" || hasPauseCollection) return "paused";

  if (
    input.eventType === "customer.subscription.resumed" ||
    hadPauseCollection ||
    (input.prevStatus ?? "").trim().toLowerCase() === "paused"
  ) {
    return "resumed";
  }

  return null;
}

/** ISO date of the subscription period end, or null. */
export function subscriptionPeriodEndDate(sub: Stripe.Subscription): string | null {
  const itemEnd = sub.items?.data?.[0]?.current_period_end;
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const unix = typeof itemEnd === "number" ? itemEnd : typeof top === "number" ? top : null;
  if (unix == null) return null;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** True when the stored access-until is still in the future (needs zeroing). */
function accessUntilStillActive(
  record: AirtableRecord,
  now: Date
): boolean {
  const raw = fieldStr(record.fields, SERVICE_ACCESS_FIELD);
  if (!raw) return false;
  const t = Date.parse(raw.length <= 10 ? `${raw}T23:59:59.999Z` : raw);
  if (Number.isNaN(t)) return false;
  return t >= now.getTime();
}

function logChanged(
  event: string,
  stripeCustomerId: string,
  record: AirtableRecord,
  fields: Record<string, unknown>
): void {
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (String(record.fields[key] ?? "") !== String(value ?? "")) {
      changed[key] = { from: record.fields[key] ?? null, to: value ?? null };
    }
  }
  if (Object.keys(changed).length === 0) return;
  console.error(
    JSON.stringify({
      event,
      source: "pause_sync",
      stripeCustomerId,
      airtableRecordId: record.id,
      changed,
    })
  );
}

async function applyPatch(
  airtable: AirtableClient,
  records: AirtableRecord[],
  fields: Record<string, unknown>,
  dryRun: boolean
): Promise<{ updated: number; skipped: number }> {
  const toUpdate: Array<{ id: string; fields: Record<string, unknown> }> = [];
  for (const record of records) {
    const changedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const existingRaw = record.fields[key];
      // Blank candidate onto blank/missing existing is NOT a change — repeated
      // webhook deliveries must not churn Airtable.
      if (typeof value === "string" && value.trim() === "") {
        if (existingRaw == null || existingRaw === "") continue;
      }
      if (billingValueChanged(key, value, existingRaw)) {
        changedFields[key] = value;
      }
    }
    if (Object.keys(changedFields).length === 0) continue;
    toUpdate.push({
      id: record.id,
      fields: {
        ...changedFields,
        [MEMBER_FIELDS.billingLastSyncedAt]: new Date().toISOString(),
      },
    });
  }
  if (!dryRun && toUpdate.length > 0) {
    await airtable.updateRecordsBatched(MEMBERS_TABLE, toUpdate);
  }
  return { updated: toUpdate.length, skipped: records.length - toUpdate.length };
}

function pauseFields(record: AirtableRecord, sub: Stripe.Subscription, now: Date) {
  const fields: Record<string, unknown> = {
    [STRIPE_SUBSCRIPTION_STATUS_FIELD]: "paused",
    [MEMBER_FIELDS.billingPauseUntil]: pauseResumeDateFromSubscription(sub) ?? "",
    [MEMBERSHIP_FIELD]: "Paused",
  };
  // Zero the access date only while it is still in the future — repeated
  // webhook deliveries (Stripe retries) must not churn the field.
  if (accessUntilStillActive(record, now)) {
    fields[SERVICE_ACCESS_FIELD] = now.toISOString();
  }
  return fields;
}

/**
 * Stripe subscription became paused (pause collection). Make the member
 * inactive in Airtable until the pause is resumed in Stripe.
 */
export async function syncSubscriptionPausedToAirtable(input: {
  airtable: AirtableClient;
  sub: Stripe.Subscription;
  dryRun?: boolean;
  now?: Date;
}): Promise<PauseSyncResult> {
  const { airtable, sub, dryRun = false, now = new Date() } = input;
  const stripeCustomerId = getStripeCustomerId(sub.customer) ?? "";

  if (!stripeCustomerId) {
    return {
      status: "no_airtable_member",
      stripeCustomerId,
      airtableRecordsMatched: 0,
      airtableRecordsUpdated: 0,
      duplicateAirtableRecords: false,
      reason: "Subscription has no Stripe Customer ID",
    };
  }

  const matches = await findAirtableMembersByStripeCustomerId(airtable, stripeCustomerId);
  if (matches.length === 0) {
    await recordIntegrationError({
      code: "STRIPE_MEMBER_NOT_FOUND",
      source: "stripe",
      operation: "customer.subscription.paused",
      title: "Paused Stripe subscription has no Airtable member",
      message: `No Airtable member for ${stripeCustomerId}`,
      severity: "warning",
      retryable: false,
      stripeCustomerId,
      stripeSubscriptionId: sub.id,
    }).catch(() => undefined);
    return {
      status: "no_airtable_member",
      stripeCustomerId,
      airtableRecordsMatched: 0,
      airtableRecordsUpdated: 0,
      duplicateAirtableRecords: false,
      reason: "No Airtable member with this exact Stripe Customer ID",
    };
  }

  let updated = 0;
  for (const record of matches) {
    const fields = pauseFields(record, sub, now);
    logChanged("billing_pause_sync", stripeCustomerId, record, fields);
    const result = await applyPatch(airtable, [record], fields, dryRun);
    updated += result.updated;
  }

  console.error(
    JSON.stringify({
      event: "billing_pause_sync",
      stripeCustomerId,
      subscriptionId: sub.id,
      resumesAt: pauseResumeDateFromSubscription(sub),
      indefinite: pauseResumeDateFromSubscription(sub) == null,
      airtableRecordsMatched: matches.length,
      airtableRecordsUpdated: updated,
      dryRun,
    })
  );

  return {
    status: updated > 0 ? "updated" : "already_up_to_date",
    stripeCustomerId,
    airtableRecordsMatched: matches.length,
    airtableRecordsUpdated: updated,
    duplicateAirtableRecords: matches.length > 1,
    reason: "Pause synced to Airtable",
  };
}

/**
 * Stripe subscription resumed from pause collection. Restore active billing
 * state; Service access until is restored from the period end only while it
 * is still in the future — a lapsed period is left for invoice.paid.
 */
export async function syncSubscriptionResumedToAirtable(input: {
  airtable: AirtableClient;
  sub: Stripe.Subscription;
  dryRun?: boolean;
  now?: Date;
}): Promise<PauseSyncResult> {
  const { airtable, sub, dryRun = false, now = new Date() } = input;
  const stripeCustomerId = getStripeCustomerId(sub.customer) ?? "";

  if (!stripeCustomerId) {
    return {
      status: "no_airtable_member",
      stripeCustomerId,
      airtableRecordsMatched: 0,
      airtableRecordsUpdated: 0,
      duplicateAirtableRecords: false,
      reason: "Subscription has no Stripe Customer ID",
    };
  }

  const matches = await findAirtableMembersByStripeCustomerId(airtable, stripeCustomerId);
  if (matches.length === 0) {
    await recordIntegrationError({
      code: "STRIPE_MEMBER_NOT_FOUND",
      source: "stripe",
      operation: "customer.subscription.resumed",
      title: "Resumed Stripe subscription has no Airtable member",
      message: `No Airtable member for ${stripeCustomerId}`,
      severity: "warning",
      retryable: false,
      stripeCustomerId,
      stripeSubscriptionId: sub.id,
    }).catch(() => undefined);
    return {
      status: "no_airtable_member",
      stripeCustomerId,
      airtableRecordsMatched: 0,
      airtableRecordsUpdated: 0,
      duplicateAirtableRecords: false,
      reason: "No Airtable member with this exact Stripe Customer ID",
    };
  }

  const live = sub.status === "active" || sub.status === "trialing";
  const periodEnd = subscriptionPeriodEndDate(sub);
  const periodEndFuture =
    periodEnd != null &&
    Date.parse(`${periodEnd}T23:59:59.999Z`) >= now.getTime();

  const baseFields: Record<string, unknown> = {
    [STRIPE_SUBSCRIPTION_STATUS_FIELD]: sub.status,
    [MEMBER_FIELDS.billingPauseUntil]: "",
  };
  if (live) {
    baseFields[MEMBERSHIP_FIELD] = "Active";
  }
  if (live && periodEndFuture) {
    baseFields[SERVICE_ACCESS_FIELD] = periodEnd!;
  }

  let updated = 0;
  for (const record of matches) {
    logChanged("billing_resume_sync", stripeCustomerId, record, baseFields);
    const result = await applyPatch(airtable, [record], baseFields, dryRun);
    updated += result.updated;
  }

  console.error(
    JSON.stringify({
      event: "billing_resume_sync",
      stripeCustomerId,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
      periodEnd,
      periodEndRestored: live && periodEndFuture,
      airtableRecordsMatched: matches.length,
      airtableRecordsUpdated: updated,
      dryRun,
    })
  );

  return {
    status: updated > 0 ? "updated" : "already_up_to_date",
    stripeCustomerId,
    airtableRecordsMatched: matches.length,
    airtableRecordsUpdated: updated,
    duplicateAirtableRecords: matches.length > 1,
    reason: "Resume synced to Airtable",
  };
}
