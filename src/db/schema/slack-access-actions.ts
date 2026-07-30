import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const slackAccessActions = pgTable(
  "slack_access_actions",
  {
    id: text("id").primaryKey(),
    actionType: text("action_type").notNull(),
    airtableRecordId: text("airtable_record_id"),
    slackUserId: text("slack_user_id"),
    targetChannelIds: text("target_channel_ids"),
    status: text("status").notNull(),
    resultJson: text("result_json"),
    error: text("error"),
    initiatedByClerkUserId: text("initiated_by_clerk_user_id"),
    runtimeMode: text("runtime_mode").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("slack_access_actions_idempotency_uidx").on(t.idempotencyKey),
    index("slack_access_actions_airtable_idx").on(t.airtableRecordId),
    index("slack_access_actions_status_idx").on(t.status),
  ]
);

export type SlackAccessAction = typeof slackAccessActions.$inferSelect;
export type NewSlackAccessAction = typeof slackAccessActions.$inferInsert;
