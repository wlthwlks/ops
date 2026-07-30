/**
 * Bounded billing reconcile helpers for cron.
 * Does not create members. Does not touch introductions.
 */
import { db } from "@/db";
import { webhookEvents, integrationErrors } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

export async function summarizeBillingReconciliation(): Promise<{
  pendingDependencyWebhooks: number;
  openStripeMemberNotFound: number;
  recentFailedWebhooks: number;
}> {
  let pendingDependencyWebhooks = 0;
  let openStripeMemberNotFound = 0;
  let recentFailedWebhooks = 0;

  try {
    const [p] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, "stripe"),
          eq(webhookEvents.status, "PENDING_DEPENDENCY")
        )
      );
    pendingDependencyWebhooks = p?.count || 0;

    const [f] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .where(
        and(eq(webhookEvents.provider, "stripe"), eq(webhookEvents.status, "FAILED"))
      );
    recentFailedWebhooks = f?.count || 0;

    const [e] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(integrationErrors)
      .where(
        and(
          eq(integrationErrors.publicErrorCode, "STRIPE_MEMBER_NOT_FOUND"),
          eq(integrationErrors.status, "open")
        )
      );
    openStripeMemberNotFound = e?.count || 0;
  } catch {
    /* tables missing */
  }

  return {
    pendingDependencyWebhooks,
    openStripeMemberNotFound,
    recentFailedWebhooks,
  };
}

export async function listPendingStripeDependencies(limit = 20) {
  try {
    return await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, "stripe"),
          eq(webhookEvents.status, "PENDING_DEPENDENCY")
        )
      )
      .orderBy(desc(webhookEvents.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}
