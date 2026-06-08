import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

// Converted from SQLite op_runs table. Serial PK preserved (integer sequence,
// no UUID needed here). Status enforced by application; add a CHECK constraint
// via a migration if stricter enforcement is required later.
export const opRuns = pgTable("op_runs", {
  id: serial("id").primaryKey(),
  opSlug: text("op_slug").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  log: text("log").notNull().default(""),
  summary: text("summary"),
});

export type OpRun = typeof opRuns.$inferSelect;
export type NewOpRun = typeof opRuns.$inferInsert;
