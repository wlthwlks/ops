import { pgTable, text, timestamp, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    livemode: boolean("livemode").notNull().default(false),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    status: text("status").notNull().default("RECEIVED"),
    payloadHash: text("payload_hash"),
    sanitizedPayload: text("sanitized_payload"),
    memberstackId: text("memberstack_id"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    airtableRecordId: text("airtable_record_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    firstReceivedAt: timestamp("first_received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorId: text("error_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_event_uidx").on(t.provider, t.providerEventId),
    index("webhook_events_status_idx").on(t.status),
    index("webhook_events_type_idx").on(t.eventType),
  ]
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
