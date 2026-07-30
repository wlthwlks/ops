import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Dedicated outreach audit log (not match intro email_deliveries).
 */
export const memberOutreach = pgTable(
  "member_outreach",
  {
    id: text("id").primaryKey(),
    airtableRecordId: text("airtable_record_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    recipientEmail: text("recipient_email").notNull(),
    outreachType: text("outreach_type").notNull(),
    city: text("city"),
    cityChannelId: text("city_channel_id"),
    allMembersChannelId: text("all_members_channel_id"),
    status: text("status").notNull(),
    resendMessageId: text("resend_message_id"),
    error: text("error"),
    sentByClerkUserId: text("sent_by_clerk_user_id"),
    runtimeMode: text("runtime_mode").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("member_outreach_idempotency_uidx").on(table.idempotencyKey),
    index("member_outreach_airtable_idx").on(table.airtableRecordId),
    index("member_outreach_recipient_idx").on(table.recipientEmail, table.createdAt),
    index("member_outreach_type_status_idx").on(table.outreachType, table.status),
  ]
);

export type MemberOutreach = typeof memberOutreach.$inferSelect;
export type NewMemberOutreach = typeof memberOutreach.$inferInsert;
