import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { members } from "./members";

export const matchEvents = pgTable(
  "match_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    initiatedBy: text("initiated_by"),
    mode: text("mode").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    newMemberId: text("new_member_id").references(() => members.id),
    newMemberEmail: text("new_member_email").notNull(),
    newMemberPostcode: text("new_member_postcode"),
    newMemberCity: text("new_member_city"),
    newMemberIndustry: text("new_member_industry"),
    summary: text("summary"),
    error: text("error"),
    slackChannelId: text("slack_channel_id"),
    slackMessageTs: text("slack_message_ts"),
    slackSentAt: timestamp("slack_sent_at", { withTimezone: true }),
    slackRecipientCount: integer("slack_recipient_count"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("match_events_request_id_idx").on(table.requestId),
    index("match_events_created_at_idx").on(table.createdAt),
    index("match_events_new_member_email_idx").on(table.newMemberEmail),
    index("match_events_city_created_at_idx").on(
      table.newMemberCity,
      table.createdAt
    ),
  ]
);

export type MatchEvent = typeof matchEvents.$inferSelect;
export type NewMatchEvent = typeof matchEvents.$inferInsert;
