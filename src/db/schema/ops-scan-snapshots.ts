import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/** Latest / historical ops dashboard scan summaries (JSON payload). */
export const opsScanSnapshots = pgTable(
  "ops_scan_snapshots",
  {
    id: text("id").primaryKey(),
    scanType: text("scan_type").notNull(),
    status: text("status").notNull(),
    summaryJson: text("summary_json").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdByClerkUserId: text("created_by_clerk_user_id"),
  },
  (table) => [
    index("ops_scan_snapshots_type_created_idx").on(table.scanType, table.createdAt),
  ]
);

export type OpsScanSnapshot = typeof opsScanSnapshots.$inferSelect;
export type NewOpsScanSnapshot = typeof opsScanSnapshots.$inferInsert;
