import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    airtableRecordId: text("airtable_record_id"),
    pineconeId: text("pinecone_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("members_email_idx").on(table.email)]
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
