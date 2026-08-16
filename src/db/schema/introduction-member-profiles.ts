import {
  pgTable,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Change-detection ledger for the semantic profile embeddings used by the
 * unified introduction engine. `profile_hash` covers the semantic fields
 * (professional headline, bio, business description, 90-day goal, help
 * wanted, expertise and connection type); when the hash changes the member's
 * vectors are re-embedded and upserted into the semantic Pinecone namespace.
 */
export const introductionMemberProfiles = pgTable(
  "introduction_member_profiles",
  {
    airtableRecordId: text("airtable_record_id").primaryKey(),
    email: text("email"),
    profileHash: text("profile_hash"),
    status: text("status").notNull().default("pending"),
    // "pending" | "synced" | "error" | "skipped"
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("introduction_member_profiles_email_idx").on(table.email),
    index("introduction_member_profiles_status_idx").on(table.status),
  ]
);

export type IntroductionMemberProfile = typeof introductionMemberProfiles.$inferSelect;
export type NewIntroductionMemberProfile = typeof introductionMemberProfiles.$inferInsert;
