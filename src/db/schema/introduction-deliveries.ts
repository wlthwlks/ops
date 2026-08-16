import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { introductionRuns } from "./introduction-runs";
import { introductionGroups } from "./introduction-groups";

/**
 * Per-recipient delivery jobs for frozen introduction plans. One logical
 * group email produces one row per recipient. `delivery_key` is the
 * canonical duplicate-send protection; `deliver_to_email` may differ from
 * `recipient_email` in canary/provider-test modes, with the original
 * recipients preserved in `original_to_json` for display/audit.
 */
export const introductionDeliveries = pgTable(
  "introduction_deliveries",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => introductionRuns.id),
    groupId: text("group_id")
      .notNull()
      .references(() => introductionGroups.id),
    recipientEmail: text("recipient_email").notNull(),
    recipientName: text("recipient_name"),
    airtableRecordId: text("airtable_record_id"),
    originalToJson: text("original_to_json"),
    deliverToEmail: text("deliver_to_email").notNull(),
    deliveryKey: text("delivery_key").notNull().unique(),
    status: text("status").notNull().default("pending"),
    // "pending" | "processing" | "sent" | "delivered" | "delayed" |
    // "bounced" | "complained" | "suppressed" | "failed"
    resendMessageId: text("resend_message_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("intro_deliveries_delivery_key_idx").on(table.deliveryKey),
    index("intro_deliveries_run_idx").on(table.runId),
    index("intro_deliveries_group_idx").on(table.groupId),
    index("intro_deliveries_status_idx").on(table.status),
    index("intro_deliveries_resend_msg_idx").on(table.resendMessageId),
    index("intro_deliveries_recipient_idx").on(table.recipientEmail),
    index("intro_deliveries_next_retry_idx").on(table.nextRetryAt),
  ]
);

export type IntroductionDelivery = typeof introductionDeliveries.$inferSelect;
export type NewIntroductionDelivery = typeof introductionDeliveries.$inferInsert;
