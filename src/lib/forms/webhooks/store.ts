import { createHash, randomUUID } from "crypto";
import { db } from "@/db";
import { webhookEvents, integrationErrors } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { sanitizePayload, type IntegrationErrorCode } from "@/lib/forms/errors";

export async function recordWebhookEvent(input: {
  provider: "stripe" | "memberstack";
  providerEventId: string;
  eventType: string;
  livemode?: boolean;
  signatureVerified: boolean;
  payload: unknown;
  memberstackId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}): Promise<{ id: string; duplicate: boolean; status: string }> {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input.payload ?? {}))
    .digest("hex");
  const sanitized = JSON.stringify(sanitizePayload(input.payload)).slice(0, 50000);

  try {
    const existing = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, input.provider),
          eq(webhookEvents.providerEventId, input.providerEventId)
        )
      )
      .limit(1);
    if (existing[0]) {
      return {
        id: existing[0].id,
        duplicate: true,
        status: existing[0].status,
      };
    }
  } catch {
    /* table may not exist yet */
  }

  const id = randomUUID();
  try {
    await db.insert(webhookEvents).values({
      id,
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      livemode: Boolean(input.livemode),
      signatureVerified: input.signatureVerified,
      status: "RECEIVED",
      payloadHash,
      sanitizedPayload: sanitized,
      memberstackId: input.memberstackId || null,
      stripeCustomerId: input.stripeCustomerId || null,
      stripeSubscriptionId: input.stripeSubscriptionId || null,
      attemptCount: 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique|duplicate/i.test(msg)) {
      return { id, duplicate: true, status: "RECEIVED" };
    }
    // DB unavailable — still return ephemeral id
    return { id, duplicate: false, status: "RECEIVED" };
  }
  return { id, duplicate: false, status: "RECEIVED" };
}

export async function updateWebhookEventStatus(
  id: string,
  status: string,
  extra?: {
    airtableRecordId?: string | null;
    errorId?: string | null;
    processedAt?: Date | null;
  }
): Promise<void> {
  try {
    await db
      .update(webhookEvents)
      .set({
        status,
        updatedAt: new Date(),
        lastAttemptAt: new Date(),
        airtableRecordId: extra?.airtableRecordId ?? undefined,
        errorId: extra?.errorId ?? undefined,
        processedAt: extra?.processedAt ?? undefined,
        attemptCount: undefined,
      })
      .where(eq(webhookEvents.id, id));
  } catch {
    /* ignore */
  }
}

export async function recordIntegrationError(input: {
  code: IntegrationErrorCode;
  source: string;
  operation: string;
  title: string;
  message: string;
  severity?: string;
  retryable?: boolean;
  details?: unknown;
  memberstackId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  airtableRecordId?: string | null;
  webhookEventId?: string | null;
  stack?: string | null;
}): Promise<string> {
  const id = randomUUID();
  try {
    await db.insert(integrationErrors).values({
      id,
      publicErrorCode: input.code,
      source: input.source,
      operation: input.operation,
      severity: input.severity || "error",
      status: "open",
      title: input.title,
      message: input.message.slice(0, 4000),
      details: input.details
        ? JSON.stringify(sanitizePayload(input.details)).slice(0, 20000)
        : null,
      stackTrace: input.stack ? input.stack.slice(0, 8000) : null,
      retryable: Boolean(input.retryable),
      memberstackId: input.memberstackId || null,
      stripeCustomerId: input.stripeCustomerId || null,
      stripeSubscriptionId: input.stripeSubscriptionId || null,
      airtableRecordId: input.airtableRecordId || null,
      webhookEventId: input.webhookEventId || null,
    });
  } catch {
    /* table may not exist */
  }
  return id;
}
