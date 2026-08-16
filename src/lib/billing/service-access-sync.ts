import type Stripe from "stripe";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  getConfiguredMembershipPriceIds,
  getConfiguredMemberstackPlanId,
  getStripeNativeMembershipPriceIds,
  hasNativeStripeMembershipPrices,
} from "@/lib/integrations/stripe";
import { MEMBERS_TABLE as AIRTABLE_MEMBERS_TABLE } from "@/lib/ops/airtable-fields";

export const SERVICE_ACCESS_FIELD = "Service access until";
export const STRIPE_CUSTOMER_ID_FIELD = "Stripe Customer ID";
export const PAYMENT_FIELD = "Payment";
export const MEMBERSHIP_FIELD = "Membership";
export const STRIPE_PRICE_ID_FIELD = "Stripe Price ID";
export const PAID_PLANS_FIELD = "Paid Plans (price ids)";
export const STRIPE_SUBSCRIPTION_ID_FIELD = "Stripe Subscription ID";
export const STRIPE_SUBSCRIPTION_STATUS_FIELD = "Stripe subscription status";
export const LAST_INVOICE_ID_FIELD = "Last invoice ID";
export const LAST_INVOICE_STATUS_FIELD = "Last invoice status";
export const BILLING_LAST_SYNCED_AT_FIELD = "Billing last synced at";
export const LAST_STRIPE_EVENT_ID_FIELD = "Last Stripe event ID";
export const CANCEL_AT_PERIOD_END_FIELD = "Cancel at period end";
export const CANCELLATION_EFFECTIVE_AT_FIELD = "Cancellation effective at";
export const FIRST_NAME_FIELD = "First Name";
export const LAST_NAME_FIELD = "Last Name";
export const MEMBERS_TABLE = AIRTABLE_MEMBERS_TABLE;

/** Deduplicate qualifying membership price ids (stable order). */
export function dedupePriceIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id.startsWith("price_") || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Paid Plans is a text field on the live base — store comma-separated unique price ids. */
export function formatPaidPlansText(priceIds: string[]): string {
  return dedupePriceIds(priceIds).join(",");
}

/** Escape a string for use inside Airtable formula double quotes. */
export function escapeAirtableFormulaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function getStripeCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (!customer) return null;
  if (typeof customer === "string") {
    const id = customer.trim();
    return id.startsWith("cus_") ? id : null;
  }
  if (typeof customer === "object" && "id" in customer && typeof customer.id === "string") {
    if ("deleted" in customer && customer.deleted) return null;
    const id = customer.id.trim();
    return id.startsWith("cus_") ? id : null;
  }
  return null;
}

/**
 * Extract Price ID from an invoice line item.
 * Supports current SDK shape (pricing.price_details.price) and common legacy shapes.
 */
export function getLinePriceId(line: Stripe.InvoiceLineItem): string | null {
  // Current Stripe API (pricing object)
  const pricing = line.pricing;
  if (pricing && typeof pricing === "object") {
    const priceDetails = (
      pricing as { price_details?: { price?: string | { id?: string } | null } | null }
    ).price_details;
    if (priceDetails?.price) {
      if (typeof priceDetails.price === "string") return priceDetails.price;
      if (typeof priceDetails.price === "object" && priceDetails.price?.id) {
        return priceDetails.price.id;
      }
    }
  }

  // Legacy / expanded shapes via narrow unknown access
  const legacy = line as unknown as {
    price?: string | { id?: string } | null;
    plan?: string | { id?: string } | null;
  };
  if (legacy.price) {
    if (typeof legacy.price === "string") return legacy.price;
    if (typeof legacy.price === "object" && legacy.price.id) return legacy.price.id;
  }
  if (legacy.plan) {
    if (typeof legacy.plan === "string") return legacy.plan;
    if (typeof legacy.plan === "object" && legacy.plan.id) return legacy.plan.id;
  }

  return null;
}

export function getLinePeriodEnd(line: Stripe.InvoiceLineItem): number | null {
  const period = line.period;
  if (!period || typeof period.end !== "number") return null;
  return period.end;
}

/**
 * Native Stripe price_… ids that qualify invoice/session lines as membership.
 * Fail closed: empty allowlist → no line qualifies (never allow-all).
 */
export function resolveNativeMembershipAllowlist(
  membershipPriceIds?: Set<string>
): Set<string> {
  if (membershipPriceIds && membershipPriceIds.size > 0) {
    return new Set([...membershipPriceIds].filter((id) => id.startsWith("price_")));
  }
  try {
    const set = getStripeNativeMembershipPriceIds({
      requireConfigured: false,
      failClosedInProduction: false,
    });
    // Checkout / resubscribe often uses the current reactivation price; include it
    // so confirm-checkout and invoice qualification match live Stripe charges.
    const reactivation = (process.env.STRIPE_REACTIVATION_PRICE_ID || "").trim();
    if (reactivation.startsWith("price_")) set.add(reactivation);
    return set;
  } catch {
    const reactivation = (process.env.STRIPE_REACTIVATION_PRICE_ID || "").trim();
    return reactivation.startsWith("price_")
      ? new Set([reactivation])
      : new Set();
  }
}

/**
 * Price ids on invoice lines that qualify as WLTH membership.
 * Only native Stripe `price_…` values present in the allowlist qualify.
 * Never treats empty / Memberstack-only config as allow-all.
 */
export function getQualifyingMembershipPriceIds(
  lines: Stripe.InvoiceLineItem[],
  membershipPriceIds: Set<string>
): string[] {
  const nativeAllow = resolveNativeMembershipAllowlist(membershipPriceIds);
  if (nativeAllow.size === 0) return [];

  const found: string[] = [];
  for (const line of lines) {
    const priceId = getLinePriceId(line);
    if (!priceId || !priceId.startsWith("price_")) continue;
    if (nativeAllow.has(priceId)) found.push(priceId);
  }
  return dedupePriceIds(found);
}

/**
 * Among invoice lines, find qualifying membership lines and return max period.end (unix seconds).
 * Fail closed when no native price_ allowlist is configured.
 */
export function getMembershipPeriodEnd(
  lines: Stripe.InvoiceLineItem[],
  membershipPriceIds: Set<string>
): number | null {
  const nativeAllow = resolveNativeMembershipAllowlist(membershipPriceIds);
  if (nativeAllow.size === 0) return null;

  let maxEnd: number | null = null;
  for (const line of lines) {
    const priceId = getLinePriceId(line);
    if (!priceId || !nativeAllow.has(priceId)) continue;
    const end = getLinePeriodEnd(line);
    if (end == null) continue;
    if (maxEnd == null || end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

/** True when production has no native price_ membership IDs configured. */
export function isMembershipPriceConfigInvalidForProduction(): boolean {
  const vercelEnv = (process.env.VERCEL_ENV || "").trim();
  const isProd = vercelEnv
    ? vercelEnv === "production"
    : process.env.NODE_ENV === "production";
  if (!isProd) return false;
  return !hasNativeStripeMembershipPrices();
}

export type MaxPaidThroughResult = {
  shouldUpdate: boolean;
  currentDate: Date | null;
  candidateDate: Date;
  finalDate: Date;
  reason: string;
  invalidCurrent?: boolean;
};

/**
 * Monotonic paid-through comparison. Never moves access backwards.
 */
export function maxPaidThroughDate(
  currentValue: string | null | undefined,
  stripePeriodEndUnix: number
): MaxPaidThroughResult {
  const candidateDate = new Date(stripePeriodEndUnix * 1000);
  if (Number.isNaN(candidateDate.getTime())) {
    throw new Error(`Invalid Stripe period end: ${stripePeriodEndUnix}`);
  }

  const raw = currentValue == null ? "" : String(currentValue).trim();
  if (!raw) {
    return {
      shouldUpdate: true,
      currentDate: null,
      candidateDate,
      finalDate: candidateDate,
      reason: "Blank Service access until",
    };
  }

  const currentDate = new Date(raw);
  if (Number.isNaN(currentDate.getTime())) {
    return {
      shouldUpdate: false,
      currentDate: null,
      candidateDate,
      finalDate: candidateDate,
      reason: "Invalid existing Service access until value",
      invalidCurrent: true,
    };
  }

  if (candidateDate.getTime() > currentDate.getTime()) {
    return {
      shouldUpdate: true,
      currentDate,
      candidateDate,
      finalDate: candidateDate,
      reason: "Stripe paid-through is later",
    };
  }

  if (candidateDate.getTime() === currentDate.getTime()) {
    return {
      shouldUpdate: false,
      currentDate,
      candidateDate,
      finalDate: currentDate,
      reason: "Already up to date",
    };
  }

  return {
    shouldUpdate: false,
    currentDate,
    candidateDate,
    finalDate: currentDate,
    reason: "Existing access date is later",
  };
}

const BILLING_DATE_FIELDS = new Set([
  SERVICE_ACCESS_FIELD,
  CANCELLATION_EFFECTIVE_AT_FIELD,
]);

/**
 * True when a candidate billing field value differs from what the record
 * currently holds. Blank/missing counts as equal to null. Date fields compare
 * by timestamp (with string fallback). "Billing last synced at" is never a
 * change by itself — it is only written when something else changed.
 */
export function billingValueChanged(
  field: string,
  candidate: unknown,
  existingRaw: unknown
): boolean {
  if (field === BILLING_LAST_SYNCED_AT_FIELD) return false;

  const existing = existingRaw == null || existingRaw === "" ? null : existingRaw;

  // Checkbox semantics: blank/false are equivalent — writing false onto a
  // never-set checkbox is not a change, writing true is.
  if (typeof candidate === "boolean") {
    return Boolean(existing) !== candidate;
  }

  if (candidate == null) {
    return existing != null;
  }
  if (existing == null) {
    return true;
  }

  if (BILLING_DATE_FIELDS.has(field)) {
    const candidateMs = Date.parse(String(candidate));
    const existingMs = Date.parse(String(existing));
    if (!Number.isNaN(candidateMs) && !Number.isNaN(existingMs)) {
      return candidateMs !== existingMs;
    }
    return String(candidate).trim() !== String(existing).trim();
  }

  return String(candidate).trim() !== String(existing).trim();
}

/** Fields read for the billing write diff — must match what updateServiceAccessUntilForCustomer compares/writes. */
export const BILLING_SYNC_READ_FIELDS = [
  STRIPE_CUSTOMER_ID_FIELD,
  SERVICE_ACCESS_FIELD,
  PAYMENT_FIELD,
  MEMBERSHIP_FIELD,
  LAST_INVOICE_ID_FIELD,
  LAST_INVOICE_STATUS_FIELD,
  CANCEL_AT_PERIOD_END_FIELD,
  CANCELLATION_EFFECTIVE_AT_FIELD,
  BILLING_LAST_SYNCED_AT_FIELD,
  STRIPE_PRICE_ID_FIELD,
  PAID_PLANS_FIELD,
  STRIPE_SUBSCRIPTION_ID_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
  LAST_STRIPE_EVENT_ID_FIELD,
  "Memberstack Plan ID",
  "Name",
] as const;

export async function findAirtableMembersByStripeCustomerId(
  airtable: AirtableClient,
  stripeCustomerId: string
): Promise<AirtableRecord[]> {
  const escaped = escapeAirtableFormulaString(stripeCustomerId);
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `{${STRIPE_CUSTOMER_ID_FIELD}} = "${escaped}"`,
    fields: [...BILLING_SYNC_READ_FIELDS],
  });
}

export type ServiceAccessSyncStatus =
  | "updated"
  | "already_up_to_date"
  | "existing_later"
  | "no_airtable_member"
  | "invalid_existing_date"
  | "skipped";

export interface ServiceAccessRecordResult {
  airtableRecordId: string;
  stripeCustomerId: string;
  oldValue: string | null;
  newValue: string | null;
  status: ServiceAccessSyncStatus;
  reason: string;
  updated: boolean;
}

export interface ServiceAccessSyncResult {
  stripeCustomerId: string;
  paidThrough: string;
  airtableRecordsMatched: number;
  airtableRecordsUpdated: number;
  duplicateAirtableRecords: boolean;
  results: ServiceAccessRecordResult[];
  status: ServiceAccessSyncStatus;
}

export type InvoiceBillingExtras = {
  /** Qualifying membership price ids from the invoice (deduped). */
  qualifyingPriceIds?: string[];
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  invoiceStatus?: string | null;
  /** Subscription cancel_at_period_end (default false). */
  cancelAtPeriodEnd?: boolean | null;
};

export async function updateServiceAccessUntilForCustomer(input: {
  airtable: AirtableClient;
  stripeCustomerId: string;
  paidThrough: Date;
  stripeInvoiceId: string;
  stripeEventId?: string;
  dryRun?: boolean;
  billing?: InvoiceBillingExtras;
  /** Allow reducing Service access until. Default false (monotonic). */
  allowServiceAccessReduction?: boolean;
  /**
   * Payment value to write. Pass null to leave Payment unchanged.
   * Default "Paid".
   */
  paymentValue?: string | null;
}): Promise<ServiceAccessSyncResult> {
  const {
    airtable,
    stripeCustomerId,
    paidThrough,
    stripeInvoiceId,
    stripeEventId,
    dryRun = false,
    billing,
    allowServiceAccessReduction = false,
    paymentValue,
  } = input;

  const paidThroughIso = paidThrough.toISOString();
  const records = await findAirtableMembersByStripeCustomerId(airtable, stripeCustomerId);

  if (records.length === 0) {
    console.warn(
      JSON.stringify({
        event: "service_access_sync_no_member",
        stripeCustomerId,
        stripeInvoiceId,
        stripeEventId: stripeEventId ?? null,
        status: "no_airtable_member",
      })
    );
    return {
      stripeCustomerId,
      paidThrough: paidThroughIso,
      airtableRecordsMatched: 0,
      airtableRecordsUpdated: 0,
      duplicateAirtableRecords: false,
      results: [],
      status: "no_airtable_member",
    };
  }

  if (records.length > 1) {
    console.warn(
      JSON.stringify({
        event: "service_access_sync_duplicate_members",
        stripeCustomerId,
        stripeInvoiceId,
        stripeEventId: stripeEventId ?? null,
        airtableRecordIds: records.map((r) => r.id),
        duplicateAirtableRecords: true,
      })
    );
  }

  const results: ServiceAccessRecordResult[] = [];
  const toUpdate: Array<{ id: string; fields: Record<string, unknown> }> = [];

  for (const rec of records) {
    const oldRaw = rec.fields[SERVICE_ACCESS_FIELD];
    const oldValue =
      oldRaw == null || oldRaw === "" ? null : String(oldRaw);
    const comparison = maxPaidThroughDate(
      oldValue,
      Math.floor(paidThrough.getTime() / 1000)
    );

    // Reduction mode: trust corrective paid-through from Stripe, bypass monotonic guard
    const effectiveShouldUpdate =
      allowServiceAccessReduction
        ? (() => {
            if (comparison.invalidCurrent) return false; // invalid ⇒ skip write
            if (comparison.shouldUpdate) return true; // forward
            // Backwards — compare raw values directly
            const candidateUnix = Math.floor(paidThrough.getTime() / 1000);
            if (oldValue) {
              const oldUnix = Math.floor(new Date(oldValue).getTime() / 1000);
              if (!Number.isNaN(oldUnix) && oldUnix !== candidateUnix) return true;
            }
            return false;
          })()
        : comparison.shouldUpdate && !comparison.invalidCurrent;

    // Authoritative paid state + billing snapshot (even if access date unchanged).
    // "Stripe Price ID" must hold a native Stripe price_…; the Memberstack commerce
    // id (prc_…) is a different kind of id and belongs only in "Memberstack Plan ID".
    const configuredPlan = getConfiguredMemberstackPlanId();
    const nativePriceIds = dedupePriceIds(billing?.qualifyingPriceIds || []);
    const primaryStripePriceId = nativePriceIds[0] || "";

    const cancelAtPeriodEnd = billing?.cancelAtPeriodEnd === true;
    const fields: Record<string, unknown> = {
      [MEMBERSHIP_FIELD]: "Active",
      [STRIPE_CUSTOMER_ID_FIELD]: stripeCustomerId,
      [LAST_INVOICE_ID_FIELD]: stripeInvoiceId,
      [LAST_INVOICE_STATUS_FIELD]: billing?.invoiceStatus ?? "paid",
      // Resubscribe / rejoin after cancel: drop stale cancel signals so UI returns to active.
      // Subscription-driven sync may pass the real cancel_at_period_end instead.
      [CANCEL_AT_PERIOD_END_FIELD]: cancelAtPeriodEnd,
      [CANCELLATION_EFFECTIVE_AT_FIELD]: cancelAtPeriodEnd ? paidThroughIso : null,
    };
    if (paymentValue !== null) {
      fields[PAYMENT_FIELD] = paymentValue ?? "Paid";
    }
    if (stripeEventId) fields[LAST_STRIPE_EVENT_ID_FIELD] = stripeEventId;
    if (primaryStripePriceId) {
      fields[STRIPE_PRICE_ID_FIELD] = primaryStripePriceId;
    }
    if (nativePriceIds.length > 0) {
      fields[PAID_PLANS_FIELD] = formatPaidPlansText(nativePriceIds);
    }
    if (billing?.stripeSubscriptionId) {
      fields[STRIPE_SUBSCRIPTION_ID_FIELD] = billing.stripeSubscriptionId;
    }
    // Real Stripe status when provided (active, trialing, past_due, canceled, unpaid, …)
    if (billing?.stripeSubscriptionStatus) {
      fields[STRIPE_SUBSCRIPTION_STATUS_FIELD] = billing.stripeSubscriptionStatus;
    } else if (billing?.stripeSubscriptionId) {
      fields[STRIPE_SUBSCRIPTION_STATUS_FIELD] = "active";
    }
    // Commerce id on the Memberstack Plan ID column — never in "Stripe Price ID".
    if (configuredPlan) {
      fields["Memberstack Plan ID"] = configuredPlan;
    }

    // Timestamp never counts as a change by itself — only written when the
    // record actually changes, so clean members keep their Last Modified Date.
    const billingFieldsChanged = Object.entries(fields).some(([key, value]) =>
      billingValueChanged(key, value, rec.fields[key])
    );

    if (comparison.invalidCurrent) {
      results.push({
        airtableRecordId: rec.id,
        stripeCustomerId,
        oldValue,
        newValue: null,
        status: "invalid_existing_date",
        reason: comparison.reason,
        updated: false,
      });
      console.error(
        JSON.stringify({
          event: "service_access_sync_invalid_date",
          stripeCustomerId,
          stripeInvoiceId,
          airtableRecordId: rec.id,
          status: "invalid_existing_date",
        })
      );
      // Still write Payment/Membership — invalid date must not leave Unpaid
      toUpdate.push({
        id: rec.id,
        fields: { ...fields, [BILLING_LAST_SYNCED_AT_FIELD]: new Date().toISOString() },
      });
      continue;
    }

    if (effectiveShouldUpdate) {
      fields[SERVICE_ACCESS_FIELD] = paidThroughIso;
      results.push({
        airtableRecordId: rec.id,
        stripeCustomerId,
        oldValue,
        newValue: paidThroughIso,
        status: "updated",
        reason: comparison.reason,
        updated: !dryRun,
      });
    } else {
      const status: ServiceAccessSyncStatus =
        comparison.reason === "Already up to date"
          ? "already_up_to_date"
          : "existing_later";
      results.push({
        airtableRecordId: rec.id,
        stripeCustomerId,
        oldValue,
        newValue: comparison.finalDate.toISOString(),
        status,
        reason: comparison.reason,
        // Access date unchanged; billing fields still written below when they differ
        updated: false,
      });
    }

    // Skip the PATCH entirely when access is unchanged AND every billing field
    // already holds the target value — avoids touching "Billing last synced at"
    // and Airtable's record modified time on clean members.
    if (!effectiveShouldUpdate && !billingFieldsChanged) {
      continue;
    }
    toUpdate.push({
      id: rec.id,
      fields: { ...fields, [BILLING_LAST_SYNCED_AT_FIELD]: new Date().toISOString() },
    });
  }

  if (!dryRun && toUpdate.length > 0) {
    await airtable.updateRecordsBatched(MEMBERS_TABLE, toUpdate);
  }

  const accessUpdatedCount = results.filter((r) => r.status === "updated").length;
  const billingRowsWritten = dryRun ? 0 : toUpdate.length;
  let overall: ServiceAccessSyncStatus = "skipped";
  if (accessUpdatedCount > 0) overall = "updated";
  else if (results.every((r) => r.status === "already_up_to_date")) {
    overall = "already_up_to_date";
  } else if (results.some((r) => r.status === "existing_later")) {
    overall = "existing_later";
  } else if (results.some((r) => r.status === "invalid_existing_date")) {
    overall = "invalid_existing_date";
  }

  console.log(
    JSON.stringify({
      event: "service_access_sync",
      stripeCustomerId,
      stripeInvoiceId,
      stripeEventId: stripeEventId ?? null,
      paidThrough: paidThroughIso,
      airtableRecordIds: records.map((r) => r.id),
      recordsMatched: records.length,
      recordsUpdated: dryRun ? 0 : accessUpdatedCount,
      billingRowsWritten,
      paymentMarkedPaid: !dryRun && billingRowsWritten > 0,
      dryRun,
      status: overall,
      duplicateAirtableRecords: records.length > 1,
    })
  );

  return {
    stripeCustomerId,
    paidThrough: paidThroughIso,
    airtableRecordsMatched: records.length,
    airtableRecordsUpdated: dryRun ? 0 : accessUpdatedCount,
    duplicateAirtableRecords: records.length > 1,
    results,
    status: overall,
  };
}

/** Minimal Stripe invoice list surface (full SDK or test mocks). */
type StripeInvoiceListClient = {
  invoices: {
    list: (params: {
      customer: string;
      status: "paid";
      limit?: number;
      starting_after?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => Promise<{ data: any[]; has_more: boolean }>;
    listLineItems: (
      invoiceId: string,
      params?: { limit?: number; starting_after?: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => Promise<{ data: any[]; has_more: boolean }>;
  };
};

/**
 * List paid invoices for a single Stripe customer (paginated).
 * Always passes `customer` + `status: "paid"` to Stripe — never lists the whole account.
 */
export async function listPaidInvoicesForCustomer(
  stripe: StripeInvoiceListClient,
  stripeCustomerId: string,
  options?: { onPage?: (page: number, pageCount: number, total: number) => void }
): Promise<Stripe.Invoice[]> {
  if (!stripeCustomerId.startsWith("cus_")) {
    throw new Error(`Invalid Stripe Customer ID: ${stripeCustomerId}`);
  }

  const invoices: Stripe.Invoice[] = [];
  let startingAfter: string | undefined;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const page = await stripe.invoices.list({
      customer: stripeCustomerId,
      status: "paid",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    invoices.push(...page.data);
    options?.onPage?.(pageNum, page.data.length, invoices.length);

    if (!page.has_more) break;

    if (page.data.length === 0) {
      throw new Error(
        `Stripe invoices.list returned has_more=true with empty data for customer ${stripeCustomerId} (page ${pageNum})`
      );
    }

    startingAfter = page.data[page.data.length - 1].id;
  }

  return invoices;
}

/**
 * List all line items for an invoice (paginated).
 */
export async function listAllInvoiceLines(
  stripe: StripeInvoiceListClient,
  invoiceId: string
): Promise<Stripe.InvoiceLineItem[]> {
  const lines: Stripe.InvoiceLineItem[] = [];
  let startingAfter: string | undefined;
  do {
    const page = await stripe.invoices.listLineItems(invoiceId, {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    lines.push(...page.data);
    if (page.has_more && page.data.length === 0) {
      throw new Error(
        `Stripe invoice line items returned has_more=true with empty data for invoice ${invoiceId}`
      );
    }
    if (page.has_more && page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id;
    } else {
      startingAfter = undefined;
    }
  } while (startingAfter);
  return lines;
}

/**
 * For one customer: list paid invoices, inspect lines, return max membership period end (unix).
 */
export async function computeLatestMembershipPeriodEndForCustomer(
  stripe: StripeInvoiceListClient,
  stripeCustomerId: string,
  membershipPriceIds: Set<string>,
  options?: {
    onInvoicePage?: (page: number, pageCount: number, total: number) => void;
    onInvoice?: (index: number, total: number, invoiceId: string) => void;
  }
): Promise<{
  periodEndUnix: number | null;
  invoicesInspected: number;
  lineRequests: number;
  qualifyingInvoices: number;
  qualifyingLines: number;
}> {
  const invoices = await listPaidInvoicesForCustomer(stripe, stripeCustomerId, {
    onPage: options?.onInvoicePage,
  });

  let maxEnd: number | null = null;
  let lineRequests = 0;
  let qualifyingInvoices = 0;
  let qualifyingLines = 0;

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    const invoiceId = inv.id;
    if (!invoiceId) continue;
    options?.onInvoice?.(i + 1, invoices.length, invoiceId);

    lineRequests++;
    const lines = await listAllInvoiceLines(stripe, invoiceId);
    const end = getMembershipPeriodEnd(lines, membershipPriceIds);
    if (end != null) {
      qualifyingInvoices++;
      qualifyingLines += 1;
      if (maxEnd == null || end > maxEnd) maxEnd = end;
    }
  }

  return {
    periodEndUnix: maxEnd,
    invoicesInspected: invoices.length,
    lineRequests,
    qualifyingInvoices,
    qualifyingLines,
  };
}

/**
 * From a paid invoice + lines, compute membership paid-through Date or null.
 */
export function paidThroughFromInvoiceLines(
  lines: Stripe.InvoiceLineItem[],
  membershipPriceIds?: Set<string>
): Date | null {
  const ids = membershipPriceIds ?? getConfiguredMembershipPriceIds();
  const endUnix = getMembershipPeriodEnd(lines, ids);
  if (endUnix == null) return null;
  return new Date(endUnix * 1000);
}

export function isValidStripeCustomerId(id: string): boolean {
  return /^cus_[A-Za-z0-9]+$/.test(id.trim());
}
