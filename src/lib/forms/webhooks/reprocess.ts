/**
 * Idempotent reprocess of a stored webhook event (OPS retry + cron).
 * Uses sanitized payload only — never re-fetches secrets.
 */
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { handleMemberstackEvent } from "@/lib/forms/webhooks/memberstack-handlers";
import { updateWebhookEventStatus, recordIntegrationError } from "@/lib/forms/webhooks/store";
import { FormsError } from "@/lib/forms/errors";

export async function reprocessWebhookEvent(id: string): Promise<{
  id: string;
  status: string;
  reason: string;
}> {
  let row;
  try {
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, id))
      .limit(1);
    row = rows[0];
  } catch (e) {
    throw new FormsError(
      "INTERNAL_UNEXPECTED_ERROR",
      e instanceof Error ? e.message : "Failed to load webhook event",
      { status: 500, retryable: true }
    );
  }

  if (!row) {
    throw new FormsError("WEBHOOK_PAYLOAD_INVALID", "Webhook event not found", {
      status: 404,
    });
  }

  if (row.status === "SUCCEEDED") {
    return { id, status: "SUCCEEDED", reason: "Already succeeded (idempotent)" };
  }

  let payload: Record<string, unknown> = {};
  if (row.sanitizedPayload) {
    try {
      payload = JSON.parse(row.sanitizedPayload) as Record<string, unknown>;
    } catch {
      throw new FormsError("WEBHOOK_PAYLOAD_INVALID", "Stored payload is not valid JSON", {
        status: 422,
      });
    }
  }

  await updateWebhookEventStatus(id, "PROCESSING");
  try {
    await db
      .update(webhookEvents)
      .set({
        attemptCount: (row.attemptCount || 0) + 1,
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(webhookEvents.id, id));
  } catch {
    /* ignore */
  }

  if (row.provider === "memberstack") {
    const result = await handleMemberstackEvent({
      eventType: row.eventType,
      payload,
    });
    const status =
      result.status === "succeeded"
        ? "SUCCEEDED"
        : result.status === "pending_dependency"
          ? "PENDING_DEPENDENCY"
          : result.status === "failed"
            ? "FAILED"
            : result.status.startsWith("ignored")
              ? "IGNORED"
              : "SUCCEEDED";
    await updateWebhookEventStatus(id, status, {
      processedAt: status === "SUCCEEDED" ? new Date() : null,
    });
    return { id, status, reason: result.reason };
  }

  if (row.provider === "stripe") {
    // Expanded Stripe reprocess needs full Stripe objects; invoice.paid path is live-only.
    // Mark pending for manual Stripe CLI replay when payload is envelope-only.
    const hasTypeOnly = payload && Object.keys(payload).length <= 3;
    if (hasTypeOnly || row.eventType === "invoice.paid") {
      await updateWebhookEventStatus(id, "PENDING_DEPENDENCY");
      await recordIntegrationError({
        code: "STRIPE_RECONCILIATION_PENDING",
        source: "stripe",
        operation: "reprocess",
        title: "Stripe event needs provider replay",
        message:
          "Stored Stripe payload is envelope-only or invoice.paid. Replay via Stripe dashboard/CLI to the live endpoint.",
        severity: "info",
        retryable: true,
        webhookEventId: id,
        stripeCustomerId: row.stripeCustomerId,
      });
      return {
        id,
        status: "PENDING_DEPENDENCY",
        reason: "Stripe reprocess requires live event replay",
      };
    }
  }

  await updateWebhookEventStatus(id, "IGNORED");
  return { id, status: "IGNORED", reason: `Unsupported provider ${row.provider}` };
}
