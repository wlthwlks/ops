import { NextRequest, NextResponse, connection } from "next/server";
import {
  listPendingStripeDependencies,
  summarizeBillingReconciliation,
} from "@/lib/forms/billing/reconcile-batch";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";

/**
 * Bounded billing reconcile summary + alert.
 * Full Stripe list is expensive — this surfaces pending dependencies for OPS.
 */
export async function POST(request: NextRequest) {
  await connection();
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  if (
    process.env.RECONCILE_BILLING_CRON_ENABLED !== "true" &&
    process.env.RECONCILE_BILLING_CRON_ENABLED !== "1"
  ) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "RECONCILE_BILLING_CRON_ENABLED is not true",
    });
  }

  const summary = await summarizeBillingReconciliation();
  const pending = await listPendingStripeDependencies(10);

  if (
    summary.pendingDependencyWebhooks > 0 ||
    summary.openStripeMemberNotFound > 0
  ) {
    await recordIntegrationError({
      code: "STRIPE_RECONCILIATION_PENDING",
      source: "cron",
      operation: "reconcile-billing",
      title: "Billing reconciliation pending",
      message: `pending_dependency=${summary.pendingDependencyWebhooks}, stripe_member_not_found=${summary.openStripeMemberNotFound}, failed=${summary.recentFailedWebhooks}`,
      severity: "warning",
      details: { summary, sampleIds: pending.map((p) => p.id) },
    }).catch(() => undefined);
  }

  return NextResponse.json({
    success: true,
    summary,
    samplePending: pending.map((p) => ({
      id: p.id,
      eventType: p.eventType,
      stripeCustomerId: p.stripeCustomerId,
      createdAt: p.createdAt,
    })),
    note: "Does not create Airtable members. Use historical CLI only for emergencies.",
  });
}

export async function GET(request: NextRequest) {
  await connection();
  return POST(request);
}
