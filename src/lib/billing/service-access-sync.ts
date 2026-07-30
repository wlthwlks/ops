import type Stripe from "stripe";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import { getConfiguredMembershipPriceIds } from "@/lib/integrations/stripe";
import { MEMBERS_TABLE as AIRTABLE_MEMBERS_TABLE } from "@/lib/ops/airtable-fields";

export const SERVICE_ACCESS_FIELD = "Service access until";
export const STRIPE_CUSTOMER_ID_FIELD = "Stripe Customer ID";
export const MEMBERS_TABLE = AIRTABLE_MEMBERS_TABLE;

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
 * Among invoice lines, find qualifying membership lines and return max period.end (unix seconds).
 */
export function getMembershipPeriodEnd(
  lines: Stripe.InvoiceLineItem[],
  membershipPriceIds: Set<string>
): number | null {
  let maxEnd: number | null = null;
  for (const line of lines) {
    const priceId = getLinePriceId(line);
    if (!priceId || !membershipPriceIds.has(priceId)) continue;
    const end = getLinePeriodEnd(line);
    if (end == null) continue;
    if (maxEnd == null || end > maxEnd) maxEnd = end;
  }
  return maxEnd;
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

export async function findAirtableMembersByStripeCustomerId(
  airtable: AirtableClient,
  stripeCustomerId: string
): Promise<AirtableRecord[]> {
  const escaped = escapeAirtableFormulaString(stripeCustomerId);
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `{${STRIPE_CUSTOMER_ID_FIELD}} = "${escaped}"`,
    fields: [STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
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

export async function updateServiceAccessUntilForCustomer(input: {
  airtable: AirtableClient;
  stripeCustomerId: string;
  paidThrough: Date;
  stripeInvoiceId: string;
  stripeEventId?: string;
  dryRun?: boolean;
}): Promise<ServiceAccessSyncResult> {
  const {
    airtable,
    stripeCustomerId,
    paidThrough,
    stripeInvoiceId,
    stripeEventId,
    dryRun = false,
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
      continue;
    }

    if (!comparison.shouldUpdate) {
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
        updated: false,
      });
      continue;
    }

    results.push({
      airtableRecordId: rec.id,
      stripeCustomerId,
      oldValue,
      newValue: paidThroughIso,
      status: "updated",
      reason: comparison.reason,
      updated: !dryRun,
    });
    toUpdate.push({
      id: rec.id,
      fields: { [SERVICE_ACCESS_FIELD]: paidThroughIso },
    });
  }

  if (!dryRun && toUpdate.length > 0) {
    await airtable.updateRecordsBatched(MEMBERS_TABLE, toUpdate);
  }

  const updatedCount = results.filter((r) => r.status === "updated").length;
  let overall: ServiceAccessSyncStatus = "skipped";
  if (updatedCount > 0) overall = "updated";
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
      recordsUpdated: dryRun ? 0 : updatedCount,
      dryRun,
      status: overall,
      duplicateAirtableRecords: records.length > 1,
    })
  );

  return {
    stripeCustomerId,
    paidThrough: paidThroughIso,
    airtableRecordsMatched: records.length,
    airtableRecordsUpdated: dryRun ? 0 : updatedCount,
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
    let invoiceQualified = false;
    for (const line of lines) {
      const priceId = getLinePriceId(line);
      if (!priceId || !membershipPriceIds.has(priceId)) continue;
      const end = getLinePeriodEnd(line);
      if (end == null) continue;
      qualifyingLines++;
      invoiceQualified = true;
      if (maxEnd == null || end > maxEnd) maxEnd = end;
    }
    if (invoiceQualified) qualifyingInvoices++;
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
