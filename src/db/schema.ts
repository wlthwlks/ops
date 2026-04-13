import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const opRuns = sqliteTable("op_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  opSlug: text("op_slug").notNull(),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  status: text("status", { enum: ["running", "success", "failed"] })
    .notNull()
    .default("running"),
  log: text("log").notNull().default(""),
  summary: text("summary"),
});

export type OpRun = typeof opRuns.$inferSelect;
export type NewOpRun = typeof opRuns.$inferInsert;
