import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Hard "never match these two people" constraints for the unified
 * introduction engine.
 *
 * Members are keyed by their Airtable record id (`at:{recordId}`) so a ban
 * survives email changes; the display email/name columns are snapshots that
 * the read path re-resolves from Airtable for freshness.
 */
export const introductionBannedPairs = pgTable(
  "introduction_banned_pairs",
  {
    id: text("id").primaryKey(),
    memberAKey: text("member_a_key").notNull(),
    memberBKey: text("member_b_key").notNull(),
    /** Sorted `member_a_key|member_b_key` — canonical, unique pair identity. */
    pairKey: text("pair_key").notNull(),
    memberAEmail: text("member_a_email"),
    memberBEmail: text("member_b_email"),
    memberAName: text("member_a_name"),
    memberBName: text("member_b_name"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("intro_banned_pairs_pair_key_uidx").on(table.pairKey),
    index("intro_banned_pairs_member_a_idx").on(table.memberAKey),
    index("intro_banned_pairs_member_b_idx").on(table.memberBKey),
  ]
);

export type IntroductionBannedPair = typeof introductionBannedPairs.$inferSelect;
export type NewIntroductionBannedPair = typeof introductionBannedPairs.$inferInsert;
