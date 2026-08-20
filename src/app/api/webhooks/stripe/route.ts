import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { createAirtableClient } from "@/lib/integrations/airtable";
import {
  getStripeClient,
  getStripeNativeMembershipPriceIds,
  getStripeWebhookSecret,
  hasNativeStripeMembershipPrices,
} from "@/lib/integrations/stripe";
import {
  getQualifyingMembershipPriceIds,
  getStripeCustomerId,
  listAllInvoiceLines,
  paidThroughFromInvoiceLines,
} from "@/lib/billing/service-access-sync";
import {
  getInvoicePaidAtUnix,
  syncInvoicePaidToAirtable,
} from "@/lib/billing/webhook-invoice-sync";
import {
  recordIntegrationError,
  recordWebhookEvent,
  updateWebhookEventStatus,
} from "@/lib/forms/webhooks/store";
import { handleExpandedStripeEvent } from "@/lib/forms/webhooks/stripe-lifecycle";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import {
  syncSubscriptionPausedToAirtable,
  syncSubscriptionResumedToAirtable,
} from "@/lib/billing/pause-sync";

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

  // Persist event envelope (best-effort)
  const stored = await recordWebhookEvent({
    provider: "stripe",
    providerEventId: event.id,
    eventType: event.type,
    livemode: event.livemode,
    signatureVerified: true,
    payload: { id: event.id, type: event.type },
  });
  if (stored.duplicate && stored.status === "SUCCEEDED") {
    return NextResponse.json({
      received: true,
      duplicate: true,
      processed: false,
      status: "SUCCEEDED",
    });
  }

  // —— Existing production path: invoice.paid (always on) ——
  if (event.type === "invoice.paid") {
    try {
      // Production (VERCEL_ENV=production): require native price_ allowlist.
      // Preview may use Memberstack prc_-only — still process if we can match
      // via commerce preview rules in paidThroughFromInvoiceLines / qualifying helpers.
      const vercelEnv = (process.env.VERCEL_ENV || "").trim();
      const isVercelProduction = vercelEnv === "production";
      const hasNative = hasNativeStripeMembershipPrices();

      if (isVercelProduction && !hasNative) {
        await recordIntegrationError({
          code: "STRIPE_MEMBERSHIP_PRICE_IDS_MISSING",
          source: "stripe_webhook",
          operation: "invoice.paid",
          title: "Stripe membership price IDs missing",
          message:
            "No native Stripe membership Price IDs (price_…) configured. Invoice ignored (fail closed).",
          details: { stripeEventId: event.id, eventType: event.type },
          retryable: false,
        }).catch(() => undefined);
        if (stored.id) {
          await updateWebhookEventStatus(stored.id, "FAILED").catch(() => undefined);
        }
        return NextResponse.json({
          received: true,
          processed: false,
          status: "configuration_error",
          reason: "STRIPE_MEMBERSHIP_PRICE_IDS must include at least one price_… id",
        });
      }

      // Prefer native allowlist; empty on preview → use empty set and rely on
      // preview recovery only in confirm-checkout (webhook stays strict on prices).
      let membershipPriceIds: Set<string>;
      try {
        membershipPriceIds = getStripeNativeMembershipPriceIds({
          requireConfigured: isVercelProduction,
          failClosedInProduction: isVercelProduction,
        });
      } catch {
        membershipPriceIds = new Set();
      }

      // Preview with prc-only: do not process invoice.paid as membership
      // (confirm-checkout handles signup return). Avoid marking random invoices Paid.
      if (!isVercelProduction && membershipPriceIds.size === 0) {
        return NextResponse.json({
          received: true,
          processed: false,
          status: "ignored",
          reason:
            "Preview has no native price_ allowlist; invoice.paid ignored (confirm-checkout handles checkout return)",
        });
      }

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

      // Only native approved price_ ids qualify
      let qualifyingPriceIds = getQualifyingMembershipPriceIds(lines, membershipPriceIds);
      // Subscription id + live status from Stripe
      const invAny = invoice as unknown as {
        subscription?: string | { id?: string } | null;
        parent?: {
          subscription_details?: { subscription?: string | { id?: string } | null } | null;
        } | null;
      };
      let stripeSubscriptionId: string | null = null;
      let stripeSubscriptionStatus: string | null = null;
      const subRef =
        invAny.subscription ??
        invAny.parent?.subscription_details?.subscription ??
        null;
      if (typeof subRef === "string" && subRef.startsWith("sub_")) {
        stripeSubscriptionId = subRef;
      } else if (subRef && typeof subRef === "object" && typeof subRef.id === "string") {
        stripeSubscriptionId = subRef.id;
      }
      if (stripeSubscriptionId) {
        try {
          const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
          stripeSubscriptionStatus = sub.status; // active | trialing | past_due | canceled | …
          const subPrices = sub.items.data
            .map((it) => it.price?.id)
            .filter((id): id is string => Boolean(id) && id.startsWith("price_"));
          if (subPrices.length > 0) {
            // Merge subscription prices so Stripe Price ID is always set
            const merged = new Set([...qualifyingPriceIds, ...subPrices]);
            qualifyingPriceIds = [...merged];
          }
        } catch {
          stripeSubscriptionStatus = "active";
        }
      }

      const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
      const airtableBase = process.env.AIRTABLE_BASE_ID;
      if (!airtableToken || !airtableBase) {
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
        billing: {
          qualifyingPriceIds,
          stripeSubscriptionId,
          stripeSubscriptionStatus,
          invoiceStatus: invoice.status || "paid",
        },
      });

      console.log(
        JSON.stringify({
          event: "stripe_webhook_invoice_paid",
          stripeEventId: event.id,
          status: sync.status,
          shouldRetry: sync.shouldRetry,
          durationMs: Date.now() - started,
        })
      );

      await updateWebhookEventStatus(stored.id, sync.shouldRetry ? "PENDING_DEPENDENCY" : "SUCCEEDED", {
        processedAt: sync.shouldRetry ? null : new Date(),
      });

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
          error: msg,
        })
      );
      await updateWebhookEventStatus(stored.id, "FAILED");
      return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
    }
  }

  // —— Always-on: Stripe pause collection (NOT gated by NEW_STRIPE_WEBHOOKS_ENABLED) ——
  // Pausing is a native Stripe billing state: the member must become inactive
  // in Airtable (status=paused, Membership=Paused, access-until zeroed) and be
  // restored on resume — regardless of the forms webhook cutover flags.
  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.paused" ||
    event.type === "customer.subscription.resumed"
  ) {
    try {
      const sub = event.data.object as Stripe.Subscription;
      const cus = getStripeCustomerId(sub.customer);
      const prevStatus = (
        event.data as { previous_attributes?: { status?: string } }
      ).previous_attributes?.status;

      const isResumeTransition =
        event.type === "customer.subscription.resumed" || prevStatus === "paused";

      if (cus && (sub.status === "paused" || isResumeTransition)) {
        const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
        const airtableBase = process.env.AIRTABLE_BASE_ID;
        if (!airtableToken || !airtableBase) {
          return NextResponse.json({ error: "Airtable not configured" }, { status: 500 });
        }
        const airtable = createAirtableClient({
          apiKey: airtableToken,
          baseId: airtableBase,
        });

        const sync =
          sub.status === "paused"
            ? await syncSubscriptionPausedToAirtable({ airtable, sub })
            : await syncSubscriptionResumedToAirtable({ airtable, sub });

        await updateWebhookEventStatus(stored.id, "SUCCEEDED", {
          processedAt: new Date(),
        }).catch(() => undefined);

        return NextResponse.json({
          received: true,
          processed: true,
          eventType: event.type,
          status: sync.status,
          stripeCustomerId: sync.stripeCustomerId,
          airtableRecordsMatched: sync.airtableRecordsMatched,
          airtableRecordsUpdated: sync.airtableRecordsUpdated,
          duplicateAirtableRecords: sync.duplicateAirtableRecords,
          reason: sync.reason,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({ event: "stripe_pause_sync_failed", error: msg })
      );
      await updateWebhookEventStatus(stored.id, "FAILED");
      return NextResponse.json({ error: "Pause sync failed" }, { status: 500 });
    }
    // Not a pause transition — fall through to the expanded handler.
  }

  // —— Expanded lifecycle (feature-flagged) ——
  const flags = getFormFeatureFlags();
  if (!flags.newStripeWebhooksEnabled) {
    await updateWebhookEventStatus(stored.id, "IGNORED");
    return NextResponse.json({
      received: true,
      processed: false,
      eventType: event.type,
      status: "ignored",
      reason: "Event type not handled (NEW_STRIPE_WEBHOOKS_ENABLED=false)",
    });
  }

  try {
    const result = await handleExpandedStripeEvent(event);
    const status =
      result.status === "pending_dependency"
        ? "PENDING_DEPENDENCY"
        : result.processed
          ? "SUCCEEDED"
          : "IGNORED";
    await updateWebhookEventStatus(stored.id, status, {
      processedAt: status === "SUCCEEDED" ? new Date() : null,
    });
    return NextResponse.json({
      received: true,
      processed: result.processed,
      eventType: event.type,
      status: result.status,
      reason: result.reason,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateWebhookEventStatus(stored.id, "FAILED");
    console.error(
      JSON.stringify({
        event: "stripe_webhook_expanded_failed",
        stripeEventId: event.id,
        error: msg,
      })
    );
    return NextResponse.json({ error: "Expanded webhook processing failed" }, { status: 500 });
  }
}
