/**
 * Stripe invoice.paid → Airtable billing sync for the webhook.
 *
 * NEVER creates Members.
 * NEVER matches or links by email.
 * ONLY updates existing Airtable members matched by exact Stripe Customer ID.
 *
 * Historical email→Stripe ID linking is CLI-only
 * (`npm run airtable:historical-stripe-repair` / reconcile scripts).
 */
import type Stripe from "stripe";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  escapeAirtableFormulaString,
  findAirtableMembersByStripeCustomerId,
  updateServiceAccessUntilForCustomer,
  type InvoiceBillingExtras,
  type ServiceAccessSyncResult,
  type ServiceAccessSyncStatus,
} from "@/lib/billing/service-access-sync";
import { normalizeEmailStrict } from "@/lib/billing/reconcile-stripe-customers";

export const PRIMARY_EMAIL_FIELD = "email";
export const DEFAULT_MEMBER_REGISTRATION_RETRY_HOURS = 24;

export type WebhookBillingStatus =
  | ServiceAccessSyncStatus
  | "member_registration_pending"
  | "stripe_member_not_found";

export type WebhookBillingResult = {
  status: WebhookBillingStatus;
  /** When true, webhook should return 503 so Stripe retries. */
  shouldRetry: boolean;
  stripeCustomerId: string;
  paidThrough: string;
  airtableRecordsMatched: number;
  airtableRecordsUpdated: number;
  duplicateAirtableRecords: boolean;
  /** Always false for webhook path — email linking is forbidden. */
  linkedStripeCustomerId: false;
  customerEmailMasked: string | null;
  reason: string;
  sync?: ServiceAccessSyncResult;
};

export function getMemberRegistrationRetryHours(): number {
  const raw = process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;
  if (raw == null || raw.trim() === "") return DEFAULT_MEMBER_REGISTRATION_RETRY_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MEMBER_REGISTRATION_RETRY_HOURS;
  return n;
}

/**
 * True while Stripe should keep retrying (member may still get Stripe Customer ID
 * written by Memberstack/onboarding/Make onto an existing Airtable row).
 * Anchor: invoice paid_at, else invoice.created (unix seconds).
 */
export function isWithinMemberRegistrationRetryWindow(input: {
  nowMs?: number;
  paidAtUnix?: number | null;
  createdUnix?: number | null;
  retryHours?: number;
}): boolean {
  const retryHours = input.retryHours ?? getMemberRegistrationRetryHours();
  if (retryHours <= 0) return false;

  const anchor =
    typeof input.paidAtUnix === "number" && Number.isFinite(input.paidAtUnix)
      ? input.paidAtUnix
      : typeof input.createdUnix === "number" && Number.isFinite(input.createdUnix)
        ? input.createdUnix
        : null;
  if (anchor == null) return false;

  const nowMs = input.nowMs ?? Date.now();
  const deadlineMs = anchor * 1000 + retryHours * 60 * 60 * 1000;
  return nowMs < deadlineMs;
}

export function getInvoicePaidAtUnix(invoice: Stripe.Invoice): number | null {
  const transitions = invoice.status_transitions;
  if (transitions && typeof transitions.paid_at === "number") {
    return transitions.paid_at;
  }
  return null;
}

export function extractStripeCustomerEmail(
  customer: Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (!customer || typeof customer !== "object") return null;
  if ("deleted" in customer && customer.deleted) return null;
  const email = "email" in customer ? customer.email : null;
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  return trimmed || null;
}

/**
 * Email lookup helper for historical CLI repair only — not used by the live webhook.
 */
export async function findAirtableMembersByPrimaryEmail(
  airtable: AirtableClient,
  email: string
): Promise<AirtableRecord[]> {
  const normalized = normalizeEmailStrict(email);
  if (!normalized) return [];
  const escaped = escapeAirtableFormulaString(normalized);
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `LOWER({${PRIMARY_EMAIL_FIELD}}) = "${escaped}"`,
    fields: [PRIMARY_EMAIL_FIELD, STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
  });
}

/** Minimal Stripe customer retrieve surface (kept for call-site compatibility). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeCustomerRetrieveClient = { customers: { retrieve: (id: string) => Promise<any> } };

/**
 * Resolve Airtable member for a paid membership invoice and update access.
 * Exact Stripe Customer ID only. Never creates members. Never email-matches.
 */
export async function syncInvoicePaidToAirtable(input: {
  airtable: AirtableClient;
  /** Unused for matching; retained so existing call sites keep compiling. */
  stripe: StripeCustomerRetrieveClient;
  stripeCustomerId: string;
  paidThrough: Date;
  stripeInvoiceId: string;
  stripeEventId?: string;
  invoicePaidAtUnix?: number | null;
  invoiceCreatedUnix?: number | null;
  dryRun?: boolean;
  nowMs?: number;
  billing?: InvoiceBillingExtras;
}): Promise<WebhookBillingResult> {
  const {
    airtable,
    stripeCustomerId,
    paidThrough,
    stripeInvoiceId,
    stripeEventId,
    invoicePaidAtUnix,
    invoiceCreatedUnix,
    dryRun = false,
    nowMs,
    billing,
  } = input;

  const paidThroughIso = paidThrough.toISOString();
  const base = {
    stripeCustomerId,
    paidThrough: paidThroughIso,
    airtableRecordsMatched: 0,
    airtableRecordsUpdated: 0,
    duplicateAirtableRecords: false,
    linkedStripeCustomerId: false as const,
    customerEmailMasked: null as string | null,
  };

  // Exact Stripe Customer ID match only
  const byCustomerId = await findAirtableMembersByStripeCustomerId(
    airtable,
    stripeCustomerId
  );

  if (byCustomerId.length > 0) {
    const sync = await updateServiceAccessUntilForCustomer({
      airtable,
      stripeCustomerId,
      paidThrough,
      stripeInvoiceId,
      stripeEventId,
      dryRun,
      billing,
    });
    return {
      ...base,
      status: sync.status,
      shouldRetry: false,
      airtableRecordsMatched: sync.airtableRecordsMatched,
      airtableRecordsUpdated: sync.airtableRecordsUpdated,
      duplicateAirtableRecords: sync.duplicateAirtableRecords,
      reason: "Matched by exact Stripe Customer ID",
      sync,
    };
  }

  // No exact ID — do not search email, do not write Airtable
  const withinWindow = isWithinMemberRegistrationRetryWindow({
    nowMs,
    paidAtUnix: invoicePaidAtUnix,
    createdUnix: invoiceCreatedUnix,
  });

  const status: WebhookBillingStatus = withinWindow
    ? "member_registration_pending"
    : "stripe_member_not_found";

  console.warn(
    JSON.stringify({
      event: withinWindow
        ? "stripe_webhook_member_registration_pending"
        : "stripe_webhook_member_not_found",
      stripeCustomerId,
      stripeInvoiceId,
      stripeEventId: stripeEventId ?? null,
      status,
      shouldRetry: withinWindow,
      retryHours: getMemberRegistrationRetryHours(),
      note: "Exact Stripe Customer ID only; email linking is CLI-only historical repair",
    })
  );

  return {
    ...base,
    status,
    shouldRetry: withinWindow,
    reason: withinWindow
      ? "No Airtable member with this exact Stripe Customer ID; within registration retry window (Stripe will retry)"
      : "No Airtable member with this exact Stripe Customer ID after retry window; not creating or email-linking from webhook",
  };
}
