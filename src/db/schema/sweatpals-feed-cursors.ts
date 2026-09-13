import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Cursor state for the SweatPals zapier-provider lifecycle feeds
 * (new-members / cancelled-members / renewed-members). Each feed row stores the
 * highest row timestamp already processed; the feed sync only processes rows
 * newer than the cursor. Reprocessing duplicates is safe because the reconcile
 * upserts are idempotent.
 */
export const sweatpalsFeedCursors = pgTable("sweatpals_feed_cursors", {
  feed: text("feed").primaryKey(),
  /** ISO timestamp of the newest row already processed (createdAt/updatedAt/renewedAt). */
  cursor: text("cursor"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type SweatpalsFeedCursor = typeof sweatpalsFeedCursors.$inferSelect;
export type NewSweatpalsFeedCursor = typeof sweatpalsFeedCursors.$inferInsert;
