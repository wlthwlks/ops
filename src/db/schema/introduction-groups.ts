import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { introductionRuns } from "./introduction-runs";

export const introductionGroups = pgTable(
  "introduction_groups",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => introductionRuns.id),
    source: text("source").notNull(), // "onboarding" | "recurring"
    cycleId: text("cycle_id"),
    channelRecordId: text("channel_record_id"),
    cityRecordId: text("city_record_id"),
    cityName: text("city_name"),
    slackChannelId: text("slack_channel_id"),
    groupFingerprint: text("group_fingerprint").notNull(),
    deliveryKey: text("delivery_key").unique(),
    status: text("status").notNull().default("planned"),
    // "planned" | "blocked" | "sending" | "sent" | "failed" |
    // "sent_tracking_failed" | "skipped"
    messageSnapshot: text("message_snapshot"),
    slackConversationId: text("slack_conversation_id"),
    slackMessageTs: text("slack_message_ts"),
    sendError: text("send_error"),
    trackingError: text("tracking_error"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("intro_groups_delivery_key_idx").on(table.deliveryKey),
    index("intro_groups_fingerprint_idx").on(table.groupFingerprint),
    index("intro_groups_run_id_idx").on(table.runId),
    index("intro_groups_cycle_id_idx").on(table.cycleId),
    index("intro_groups_status_idx").on(table.status),
  ]
);

export type IntroductionGroup = typeof introductionGroups.$inferSelect;
export type NewIntroductionGroup = typeof introductionGroups.$inferInsert;
