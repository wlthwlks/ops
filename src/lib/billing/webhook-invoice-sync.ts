/**
 * Stripe invoice.paid → Airtable billing sync for the webhook.
 * NEVER creates Members. Memberstack + Make own ongoing registration.
 * May link blank Stripe Customer ID via unique primary email match only.
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
  type ServiceAccessSyncResult,
  type ServiceAccessSyncStatus,
} from "@/lib/billing/service-access-sync";
import {
  isValidEmail,
  maskEmail,
  normalizeEmailStrict,
} from "@/lib/billing/reconcile-stripe-customers";

export const PRIMARY_EMAIL_FIELD = "email";
export const DEFAULT_MEMBER_REGISTRATION_RETRY_HOURS = 24;

export type WebhookBillingStatus =
  | ServiceAccessSyncStatus
  | "linked_and_updated"
  | "member_registration_pending"
  | "email_conflict"
  | "stripe_customer_id_conflict"
  | "no_customer_email"
  | "invalid_customer_email";

export type WebhookBillingResult = {
  status: WebhookBillingStatus;
  /** When true, webhook should return 503 so Stripe retries. */
  shouldRetry: boolean;
  stripeCustomerId: string;
  paidThrough: string;
  airtableRecordsMatched: number;
  airtableRecordsUpdated: number;
  duplicateAirtableRecords: boolean;
  linkedStripeCustomerId: boolean;
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
 * True while Stripe should keep retrying (member may still be created by Make).
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

export async function findAirtableMembersByPrimaryEmail(
  airtable: AirtableClient,
  email: string
): Promise<AirtableRecord[]> {
  const normalized = normalizeEmailStrict(email);
  if (!normalized) return [];
  const escaped = escapeAirtableFormulaString(normalized);
  // Case-insensitive match on primary email only (not Slack Email).
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `LOWER({${PRIMARY_EMAIL_FIELD}}) = "${escaped}"`,
    fields: [PRIMARY_EMAIL_FIELD, STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
  });
}

/** Minimal Stripe customer retrieve surface (full SDK or test mocks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeCustomerRetrieveClient = { customers: { retrieve: (id: string) => Promise<any> } };

/**
 * Resolve Airtable member for a paid membership invoice and update access.
 * Never creates Members. Optionally links blank Stripe Customer ID on unique email match.
 */
export async function syncInvoicePaidToAirtable(input: {
  airtable: AirtableClient;
  stripe: StripeCustomerRetrieveClient;
  stripeCustomerId: string;
  paidThrough: Date;
  stripeInvoiceId: string;
  stripeEventId?: string;
  invoicePaidAtUnix?: number | null;
  invoiceCreatedUnix?: number | null;
  dryRun?: boolean;
  nowMs?: number;
}): Promise<WebhookBillingResult> {
  const {
    airtable,
    stripe,
    stripeCustomerId,
    paidThrough,
    stripeInvoiceId,
    stripeEventId,
    invoicePaidAtUnix,
    invoiceCreatedUnix,
    dryRun = false,
    nowMs,
  } = input;

  const paidThroughIso = paidThrough.toISOString();
  const base = {
    stripeCustomerId,
    paidThrough: paidThroughIso,
    airtableRecordsMatched: 0,
    airtableRecordsUpdated: 0,
    duplicateAirtableRecords: false,
    linkedStripeCustomerId: false,
    customerEmailMasked: null as string | null,
  };

  // 1) Exact Stripe Customer ID match
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
    });
    return {
      ...base,
      status: sync.status,
      shouldRetry: false,
      airtableRecordsMatched: sync.airtableRecordsMatched,
      airtableRecordsUpdated: sync.airtableRecordsUpdated,
      duplicateAirtableRecords: sync.duplicateAirtableRecords,
      reason: "Matched by Stripe Customer ID",
      sync,
    };
  }

  // 2) No ID match — try unique primary email link (blank Stripe Customer ID only)
  let customer: Stripe.Customer | Stripe.DeletedCustomer | null;
  try {
    customer = (await stripe.customers.retrieve(stripeCustomerId)) as
      | Stripe.Customer
      | Stripe.DeletedCustomer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "stripe_webhook_customer_retrieve_failed",
        stripeCustomerId,
        stripeInvoiceId,
        stripeEventId: stripeEventId ?? null,
        error: msg,
      })
    );
    throw err;
  }

  const rawEmail = extractStripeCustomerEmail(customer);
  if (!rawEmail) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_no_customer_email",
        stripeCustomerId,
        stripeInvoiceId,
        stripeEventId: stripeEventId ?? null,
        status: "no_customer_email",
      })
    );
    return {
      ...base,
      status: "no_customer_email",
      shouldRetry: false,
      reason: "Stripe customer has no email; cannot link or wait on registration",
    };
  }

  const masked = maskEmail(rawEmail);
  base.customerEmailMasked = masked;

  if (!isValidEmail(rawEmail)) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_invalid_customer_email",
        stripeCustomerId,
        stripeInvoiceId,
        stripeEventId: stripeEventId ?? null,
        status: "invalid_customer_email",
        emailMasked: masked,
      })
    );
    return {
      ...base,
      status: "invalid_customer_email",
      shouldRetry: false,
      reason: "Stripe customer email is invalid",
    };
  }

  const byEmail = await findAirtableMembersByPrimaryEmail(airtable, rawEmail);

  if (byEmail.length > 1) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_email_conflict",
        stripeCustomerId,
        stripeInvoiceId,
        stripeEventId: stripeEventId ?? null,
        status: "email_conflict",
        emailMasked: masked,
        airtableRecordIds: byEmail.map((r) => r.id),
      })
    );
    return {
      ...base,
      status: "email_conflict",
      shouldRetry: false,
      airtableRecordsMatched: byEmail.length,
      duplicateAirtableRecords: true,
      reason: "Multiple Airtable Members share this primary email",
    };
  }

  if (byEmail.length === 1) {
    const rec = byEmail[0];
    const existingIdRaw = rec.fields[STRIPE_CUSTOMER_ID_FIELD];
    const existingId =
      existingIdRaw == null || existingIdRaw === ""
        ? ""
        : String(existingIdRaw).trim();

    if (existingId && existingId !== stripeCustomerId) {
      console.warn(
        JSON.stringify({
          event: "stripe_webhook_customer_id_conflict",
          stripeCustomerId,
          stripeInvoiceId,
          stripeEventId: stripeEventId ?? null,
          status: "stripe_customer_id_conflict",
          airtableRecordId: rec.id,
          emailMasked: masked,
        })
      );
      return {
        ...base,
        status: "stripe_customer_id_conflict",
        shouldRetry: false,
        airtableRecordsMatched: 1,
        reason:
          "Airtable member already has a different Stripe Customer ID; not overwriting",
      };
    }

    // Link blank ID, then update access via customer-id path
    if (!existingId) {
      if (!dryRun) {
        await airtable.updateRecordsBatched(MEMBERS_TABLE, [
          {
            id: rec.id,
            fields: { [STRIPE_CUSTOMER_ID_FIELD]: stripeCustomerId },
          },
        ]);
      }
      console.log(
        JSON.stringify({
          event: "stripe_webhook_linked_customer_id",
          stripeCustomerId,
          stripeInvoiceId,
          stripeEventId: stripeEventId ?? null,
          airtableRecordId: rec.id,
          emailMasked: masked,
          dryRun,
        })
      );
    }

    const sync = await updateServiceAccessUntilForCustomer({
      airtable,
      stripeCustomerId,
      paidThrough,
      stripeInvoiceId,
      stripeEventId,
      dryRun,
    });

    // If dry-run link didn't write ID, update by customer id may find 0 — update the record directly
    if (dryRun && !existingId && sync.status === "no_airtable_member") {
      return {
        ...base,
        status: "linked_and_updated",
        shouldRetry: false,
        airtableRecordsMatched: 1,
        airtableRecordsUpdated: 0,
        linkedStripeCustomerId: true,
        reason: "Would link blank Stripe Customer ID and update Service access until",
        sync,
      };
    }

    const linked = !existingId;
    const status: WebhookBillingStatus = linked
      ? sync.status === "updated" || sync.status === "already_up_to_date" || sync.status === "existing_later"
        ? "linked_and_updated"
        : sync.status
      : sync.status;

    return {
      ...base,
      status,
      shouldRetry: false,
      airtableRecordsMatched: Math.max(sync.airtableRecordsMatched, 1),
      airtableRecordsUpdated: sync.airtableRecordsUpdated,
      duplicateAirtableRecords: sync.duplicateAirtableRecords,
      linkedStripeCustomerId: linked,
      reason: linked
        ? "Linked blank Stripe Customer ID via unique primary email, then synced access"
        : "Matched existing Stripe Customer ID on email record",
      sync,
    };
  }

  // 3) No Airtable member yet — registration may still be in flight (Make)
  const withinWindow = isWithinMemberRegistrationRetryWindow({
    nowMs,
    paidAtUnix: invoicePaidAtUnix,
    createdUnix: invoiceCreatedUnix,
  });

  console.warn(
    JSON.stringify({
      event: "stripe_webhook_member_registration_pending",
      stripeCustomerId,
      stripeInvoiceId,
      stripeEventId: stripeEventId ?? null,
      status: "member_registration_pending",
      emailMasked: masked,
      shouldRetry: withinWindow,
      retryHours: getMemberRegistrationRetryHours(),
    })
  );

  return {
    ...base,
    status: "member_registration_pending",
    shouldRetry: withinWindow,
    reason: withinWindow
      ? "No Airtable member yet; within registration retry window"
      : "No Airtable member after registration retry window; not creating from webhook",
  };
}
