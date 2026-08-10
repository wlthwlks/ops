/**
 * Expanded Stripe lifecycle handlers (feature-flagged).
 * Never creates Airtable members. Never uses email fallback.
 * Does not modify introductions/matching.
 */
import type Stripe from "stripe";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { updateMemberBilling } from "@/lib/forms/airtable/members-sync";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";
import { canApplyExpandedStripeWebhooks } from "@/lib/forms/feature-flags";
import { classifyChargeRefundFromStripe } from "@/lib/billing/stripe-entitlement";

function customerId(ref: string | Stripe.Customer | Stripe.DeletedCustomer | null): string {
  if (!ref) return "";
  if (typeof ref === "string") return ref;
  return ref.id || "";
}

function subId(ref: string | Stripe.Subscription | null | undefined): string {
  if (!ref) return "";
  if (typeof ref === "string") return ref;
  return ref.id || "";
}

export async function handleExpandedStripeEvent(event: Stripe.Event): Promise<{
  processed: boolean;
  status: string;
  reason: string;
}> {
  if (!canApplyExpandedStripeWebhooks()) {
    return {
      processed: false,
      status: "ignored_flag_off",
      reason: "NEW_STRIPE_WEBHOOKS_ENABLED is false (or shadow mode)",
    };
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const cus = customerId(sub.customer);
      if (!cus) {
        return { processed: false, status: "ignored", reason: "No customer" };
      }
      const periodEnd = sub.items?.data?.[0]?.current_period_end
        ? new Date(sub.items.data[0].current_period_end * 1000).toISOString()
        : sub.cancel_at
          ? new Date(sub.cancel_at * 1000).toISOString()
          : "";
      // Stripe types vary by API version — use safe access
      const currentPeriodEnd =
        (sub as unknown as { current_period_end?: number }).current_period_end ||
        sub.items?.data?.[0]?.current_period_end;

      const accessUntil = currentPeriodEnd
        ? new Date(currentPeriodEnd * 1000).toISOString().slice(0, 10)
        : periodEnd
          ? periodEnd.slice(0, 10)
          : undefined;

      const patch: Record<string, unknown> = {
        [MEMBER_FIELDS.stripeSubscriptionId]: sub.id,
        [MEMBER_FIELDS.stripeCustomerId]: cus,
      };

      if (sub.cancel_at_period_end) {
        patch[MEMBER_FIELDS.cancelAtPeriodEnd] = "true";
        patch[MEMBER_FIELDS.cancellationRequestedAt] = new Date().toISOString();
        if (accessUntil) {
          patch[MEMBER_FIELDS.cancellationEffectiveAt] = accessUntil;
          patch[MEMBER_FIELDS.serviceAccessUntil] = accessUntil;
        }
        // Membership remains Active during grace
        patch[MEMBER_FIELDS.membership] = "Active";
      } else if (sub.status === "active" || sub.status === "trialing") {
        patch[MEMBER_FIELDS.cancelAtPeriodEnd] = "false";
        patch[MEMBER_FIELDS.cancellationEffectiveAt] = "";
        patch[MEMBER_FIELDS.membership] = "Active";
        patch[MEMBER_FIELDS.payment] = "Paid";
        if (accessUntil) patch[MEMBER_FIELDS.serviceAccessUntil] = accessUntil;
      }

      const result = await updateMemberBilling({
        stripeCustomerId: cus,
        patch,
      });
      if (result.status === "STRIPE_MEMBER_NOT_FOUND") {
        await recordIntegrationError({
          code: "STRIPE_MEMBER_NOT_FOUND",
          source: "stripe",
          operation: event.type,
          title: "Stripe customer has no Airtable member",
          message: `No Airtable member for ${cus}`,
          severity: "warning",
          retryable: true,
          stripeCustomerId: cus,
          stripeSubscriptionId: sub.id,
        });
        return {
          processed: true,
          status: "pending_dependency",
          reason: "Member not found — not created",
        };
      }
      return { processed: true, status: result.status, reason: "Subscription reconciled" };
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const cus = customerId(sub.customer);
      if (!cus) return { processed: false, status: "ignored", reason: "No customer" };
      const result = await updateMemberBilling({
        stripeCustomerId: cus,
        patch: {
          [MEMBER_FIELDS.membership]: "Cancelled",
          [MEMBER_FIELDS.cancellationEffectiveAt]: new Date().toISOString(),
          [MEMBER_FIELDS.cancelAtPeriodEnd]: "false",
          // Preserve Service access until — do not clear
        },
      });
      if (result.status === "STRIPE_MEMBER_NOT_FOUND") {
        await recordIntegrationError({
          code: "STRIPE_MEMBER_NOT_FOUND",
          source: "stripe",
          operation: event.type,
          title: "Subscription deleted but no Airtable member",
          message: cus,
          stripeCustomerId: cus,
        });
      }
      return { processed: true, status: result.status, reason: "Subscription ended" };
    }

    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const cus = customerId(inv.customer);
      if (!cus) return { processed: false, status: "ignored", reason: "No customer" };
      const result = await updateMemberBilling({
        stripeCustomerId: cus,
        patch: {
          [MEMBER_FIELDS.payment]: "Failed",
        },
      });
      await recordIntegrationError({
        code: "STRIPE_PAYMENT_FAILED",
        source: "stripe",
        operation: event.type,
        title: "Invoice payment failed",
        message: `Invoice ${inv.id} failed for ${cus}`,
        severity: "warning",
        retryable: false,
        stripeCustomerId: cus,
      });
      return { processed: true, status: result.status, reason: "Payment failed recorded" };
    }

    case "invoice.payment_action_required": {
      const inv = event.data.object as Stripe.Invoice;
      const cus = customerId(inv.customer);
      await recordIntegrationError({
        code: "STRIPE_RECONCILIATION_PENDING",
        source: "stripe",
        operation: event.type,
        title: "Payment action required",
        message: `Invoice ${inv.id}`,
        severity: "warning",
        stripeCustomerId: cus || null,
      });
      return { processed: true, status: "warning_recorded", reason: "Action required" };
    }

    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const cus = customerId(session.customer as string | Stripe.Customer | null);
      const sub = subId(session.subscription as string | Stripe.Subscription | null);
      if (!cus) return { processed: false, status: "ignored", reason: "No customer on session" };
      const result = await updateMemberBilling({
        stripeCustomerId: cus,
        patch: {
          [MEMBER_FIELDS.stripeCustomerId]: cus,
          ...(sub ? { [MEMBER_FIELDS.stripeSubscriptionId]: sub } : {}),
          [MEMBER_FIELDS.payment]: "Paid",
          [MEMBER_FIELDS.membership]: "Active",
        },
      });
      if (result.status === "STRIPE_MEMBER_NOT_FOUND") {
        await recordIntegrationError({
          code: "STRIPE_RECONCILIATION_PENDING",
          source: "stripe",
          operation: event.type,
          title: "Checkout completed — awaiting Memberstack linkage",
          message: cus,
          severity: "info",
          retryable: true,
          stripeCustomerId: cus,
          stripeSubscriptionId: sub || null,
        });
        return {
          processed: true,
          status: "pending_dependency",
          reason: "Member not found yet",
        };
      }
      return { processed: true, status: result.status, reason: "Checkout linked" };
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const cus = customerId(charge.customer);
      if (!cus) {
        return { processed: true, status: "manual_review", reason: "Refund logged — no Stripe customer" };
      }

      const refundKind = classifyChargeRefundFromStripe(charge);
      const patch: Record<string, unknown> = {};

      if (refundKind === "full") {
        patch[MEMBER_FIELDS.payment] = "Refunded";
      }

      const result = await updateMemberBilling({
        stripeCustomerId: cus,
        patch,
      });

      await recordIntegrationError({
        code: "STRIPE_RECONCILIATION_PENDING",
        source: "stripe",
        operation: event.type,
        title: refundKind === "full"
          ? "Charge fully refunded — Payment set to Refunded"
          : refundKind === "partial"
            ? "Charge partially refunded — manual review"
            : "Charge refunded — manual review",
        message: `Charge ${charge.id} (refund kind: ${refundKind})`,
        severity: "warning",
        stripeCustomerId: cus,
      });

      if (refundKind === "full") {
        return { processed: true, status: result.status, reason: "Full refund — Payment set to Refunded" };
      }
      return { processed: true, status: "manual_review", reason: "Partial/unknown refund — manual review" };
    }

    default:
      return {
        processed: false,
        status: "ignored",
        reason: `Unhandled expanded type ${event.type}`,
      };
  }
}
