import { eq } from "drizzle-orm";
import { Webhook } from "svix";
import type { AppDb } from "@/db";
import {
  introductionDeliveries,
  introductionDeliveryEvents,
} from "@/db/schema";

/**
 * Verified Resend webhook processing for introduction deliveries.
 * Events are idempotent (unique delivery/event/provider-event rows) and
 * out-of-order safe: provider timestamps are applied monotonically via
 * last_event_at, so a late event can never regress a delivery's status.
 */

export interface ResendWebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export interface ResendWebhookEvent {
  created_at?: number;
  type?: string;
  data?: {
    id?: string;
    to?: string[];
    subject?: string;
  };
}

export type WebhookVerifyResult = { ok: true } | { ok: false; error: string };

export function verifyResendWebhook(
  rawPayload: string,
  headers: ResendWebhookHeaders,
  secret: string
): WebhookVerifyResult {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, error: "Missing svix headers" };
  }
  try {
    const webhook = new Webhook(secret);
    webhook.verify(rawPayload, {
      "svix-id": headers.id,
      "svix-timestamp": headers.timestamp,
      "svix-signature": headers.signature,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Signature verification failed" };
  }
}

interface EventMapping {
  status?: string;
  terminal?: boolean;
}

/** Provider event types → delivery states. Opened/clicked are recorded only. */
const EVENT_MAPPING: Record<string, EventMapping> = {
  "email.sent": { status: "sent" },
  "email.delivered": { status: "delivered" },
  "email.delivery_delayed": { status: "delayed" },
  "email.bounced": { status: "bounced", terminal: true },
  "email.complained": { status: "complained", terminal: true },
  "email.failed": { status: "failed", terminal: true },
  "email.suppressed": { status: "suppressed", terminal: true },
  "email.opened": {},
  "email.clicked": {},
};

export interface WebhookApplyResult {
  applied: number;
  ignored: number;
  ignoredReasons: string[];
}

export async function applyResendWebhookEvent(
  db: AppDb,
  event: ResendWebhookEvent,
  options: { now?: Date; log?: (message: string) => void } = {}
): Promise<WebhookApplyResult> {
  const now = options.now ?? new Date();
  const mapping = event.type ? EVENT_MAPPING[event.type] : undefined;
  const messageId = event.data?.id;
  const recipients = event.data?.to ?? [];
  const eventTs =
    event.created_at != null ? new Date(event.created_at * 1000) : null;

  const result: WebhookApplyResult = { applied: 0, ignored: 0, ignoredReasons: [] };

  if (!mapping) {
    result.ignored += 1;
    result.ignoredReasons.push(`Unsupported event type ${event.type ?? "unknown"}`);
    return result;
  }
  if (!messageId) {
    result.ignored += 1;
    result.ignoredReasons.push("Event has no message id");
    return result;
  }

  const rows = await db
    .select()
    .from(introductionDeliveries)
    .where(eq(introductionDeliveries.resendMessageId, messageId));

  if (rows.length === 0) {
    options.log?.(`Webhook ${event.type}: no delivery rows for resend message ${messageId}`);
    return result;
  }

  for (const delivery of rows) {
    const matchesRecipient = recipients.some(
      (r) => r.trim().toLowerCase() === delivery.deliverToEmail.trim().toLowerCase()
    );
    if (recipients.length > 0 && !matchesRecipient) continue;

    // Out-of-order guard: never apply an event older than the newest seen.
    if (delivery.lastEventAt && eventTs && eventTs.getTime() < new Date(delivery.lastEventAt).getTime()) {
      result.ignored += 1;
      result.ignoredReasons.push(`Out-of-order ${event.type} for ${delivery.id}`);
      continue;
    }

    // Idempotency: unique (delivery, event_type, provider_event_id).
    const inserted = await db
      .insert(introductionDeliveryEvents)
      .values({
        id: crypto.randomUUID(),
        deliveryId: delivery.id,
        eventType: event.type ?? "unknown",
        providerEventId: messageId,
        providerTs: eventTs,
        payloadJson: JSON.stringify(event),
      })
      .onConflictDoNothing()
      .returning({ id: introductionDeliveryEvents.id });

    if (inserted.length === 0) {
      result.ignored += 1;
      result.ignoredReasons.push(`Duplicate ${event.type} for ${delivery.id}`);
      continue;
    }

    if (mapping.status) {
      const terminalStatuses = ["bounced", "complained", "failed", "suppressed"];
      const alreadyTerminal = terminalStatuses.includes(delivery.status);
      // Terminal states are absorbing: a later "delivered" must not override.
      if (!alreadyTerminal || (mapping.terminal && terminalStatuses.includes(mapping.status))) {
        await db
          .update(introductionDeliveries)
          .set({
            status: mapping.status,
            lastEventAt: eventTs ?? now,
            completedAt: mapping.terminal ? now : delivery.completedAt,
          })
          .where(eq(introductionDeliveries.id, delivery.id));
      } else {
        await db
          .update(introductionDeliveries)
          .set({ lastEventAt: eventTs ?? now })
          .where(eq(introductionDeliveries.id, delivery.id));
      }
    } else {
      await db
        .update(introductionDeliveries)
        .set({ lastEventAt: eventTs ?? now })
        .where(eq(introductionDeliveries.id, delivery.id));
    }

    result.applied += 1;
  }

  return result;
}

export async function findDeliveriesByMessageId(db: AppDb, messageId: string) {
  return db
    .select()
    .from(introductionDeliveries)
    .where(eq(introductionDeliveries.resendMessageId, messageId));
}
