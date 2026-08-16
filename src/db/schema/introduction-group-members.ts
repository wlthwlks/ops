import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { introductionGroups } from "./introduction-groups";
import { members } from "./members";

export const introductionGroupMembers = pgTable(
  "introduction_group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => introductionGroups.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => members.id),
    airtableRecordId: text("airtable_record_id"),
    emailSnapshot: text("email_snapshot").notNull(),
    slackUserId: text("slack_user_id"),
    role: text("role").notNull(), // "new_member" | "match" | "recurring"
    memberSnapshotJson: text("member_snapshot_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("group_members_group_airtable_idx")
      .on(table.groupId, table.airtableRecordId),
    index("group_members_group_id_idx").on(table.groupId),
    index("group_members_email_idx").on(table.emailSnapshot),
    index("group_members_airtable_idx").on(table.airtableRecordId),
  ]
);

export type IntroductionGroupMember = typeof introductionGroupMembers.$inferSelect;
export type NewIntroductionGroupMember = typeof introductionGroupMembers.$inferInsert;
