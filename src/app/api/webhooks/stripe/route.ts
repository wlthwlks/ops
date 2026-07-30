import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { createAirtableClient } from "@/lib/integrations/airtable";
import {
  getConfiguredMembershipPriceIds,
  getStripeClient,
  getStripeWebhookSecret,
} from "@/lib/integrations/stripe";
import {
  getStripeCustomerId,
  listAllInvoiceLines,
  paidThroughFromInvoiceLines,
} from "@/lib/billing/service-access-sync";
import {
  getInvoicePaidAtUnix,
  syncInvoicePaidToAirtable,
} from "@/lib/billing/webhook-invoice-sync";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const started = Date.now();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe-Signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await request.text();
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, signature, getStripeWebhookSecret());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "stripe_webhook_signature_failed",
        error: msg,
        durationMs: Date.now() - started,
      })
    );
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }

  if (event.type !== "invoice.paid") {
    return NextResponse.json({
      received: true,
      processed: false,
      eventType: event.type,
      status: "ignored",
      reason: "Event type not handled",
    });
  }

  try {
    const membershipPriceIds = getConfiguredMembershipPriceIds({ requireConfigured: true });
    const stripe = getStripeClient();

    const invoiceFromEvent = event.data.object as Stripe.Invoice;
    const invoiceId = invoiceFromEvent.id;
    if (!invoiceId) {
      return NextResponse.json(
        { received: true, processed: false, status: "ignored", reason: "Invoice missing id" },
        { status: 200 }
      );
    }

    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.status !== "paid") {
      return NextResponse.json({
        received: true,
        processed: false,
        eventType: event.type,
        invoiceId,
        status: "ignored",
        reason: `Invoice status is ${invoice.status ?? "unknown"}, not paid`,
      });
    }

    const stripeCustomerId = getStripeCustomerId(invoice.customer);
    if (!stripeCustomerId) {
      return NextResponse.json({
        received: true,
        processed: false,
        eventType: event.type,
        invoiceId,
        status: "ignored",
        reason: "No Stripe Customer ID on invoice",
      });
    }

    const lines = await listAllInvoiceLines(stripe, invoiceId);
    const paidThrough = paidThroughFromInvoiceLines(lines, membershipPriceIds);
    if (!paidThrough) {
      return NextResponse.json({
        received: true,
        processed: false,
        eventType: event.type,
        invoiceId,
        stripeCustomerId,
        status: "ignored",
        reason: "No qualifying membership price found",
      });
    }

    const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
    const airtableBase = process.env.AIRTABLE_BASE_ID;
    if (!airtableToken || !airtableBase) {
      console.error(
        JSON.stringify({
          event: "stripe_webhook_missing_airtable_config",
          stripeEventId: event.id,
          invoiceId,
        })
      );
      return NextResponse.json({ error: "Airtable not configured" }, { status: 500 });
    }

    const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
    const sync = await syncInvoicePaidToAirtable({
      airtable,
      stripe,
      stripeCustomerId,
      paidThrough,
      stripeInvoiceId: invoiceId,
      stripeEventId: event.id,
      invoicePaidAtUnix: getInvoicePaidAtUnix(invoice),
      invoiceCreatedUnix: typeof invoice.created === "number" ? invoice.created : null,
      dryRun: false,
    });

    console.log(
      JSON.stringify({
        event: "stripe_webhook_invoice_paid",
        stripeEventId: event.id,
        stripeEventType: event.type,
        stripeInvoiceId: invoiceId,
        stripeCustomerId,
        status: sync.status,
        shouldRetry: sync.shouldRetry,
        recordsMatched: sync.airtableRecordsMatched,
        recordsUpdated: sync.airtableRecordsUpdated,
        linkedStripeCustomerId: sync.linkedStripeCustomerId,
        paidThrough: sync.paidThrough,
        durationMs: Date.now() - started,
      })
    );

    const body = {
      received: true,
      processed: true,
      eventType: event.type,
      invoiceId,
      stripeCustomerId,
      airtableRecordsMatched: sync.airtableRecordsMatched,
      airtableRecordsUpdated: sync.airtableRecordsUpdated,
      paidThrough: sync.paidThrough,
      status: sync.status,
      shouldRetry: sync.shouldRetry,
      linkedStripeCustomerId: sync.linkedStripeCustomerId,
      duplicateAirtableRecords: sync.duplicateAirtableRecords,
      reason: sync.reason,
    };

    // 503 only while Make/Memberstack may still create the Member (Stripe retries).
    if (sync.shouldRetry) {
      return NextResponse.json(body, { status: 503 });
    }

    return NextResponse.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "stripe_webhook_processing_failed",
        stripeEventId: event.id,
        stripeEventType: event.type,
        error: msg,
        durationMs: Date.now() - started,
      })
    );
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
