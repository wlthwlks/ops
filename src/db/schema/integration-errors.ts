import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

export const integrationErrors = pgTable(
  "integration_errors",
  {
    id: text("id").primaryKey(),
    publicErrorCode: text("public_error_code").notNull(),
    source: text("source").notNull(),
    operation: text("operation").notNull(),
    severity: text("severity").notNull().default("error"),
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    message: text("message").notNull(),
    details: text("details"),
    stackTrace: text("stack_trace"),
    retryable: boolean("retryable").notNull().default(false),
    attemptCount: integer("attempt_count").notNull().default(0),
    memberstackId: text("memberstack_id"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    airtableRecordId: text("airtable_record_id"),
    webhookEventId: text("webhook_event_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNotes: text("resolution_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("integration_errors_status_idx").on(t.status),
    index("integration_errors_code_idx").on(t.publicErrorCode),
    index("integration_errors_source_idx").on(t.source),
  ]
);

export type IntegrationError = typeof integrationErrors.$inferSelect;
export type NewIntegrationError = typeof integrationErrors.$inferInsert;
