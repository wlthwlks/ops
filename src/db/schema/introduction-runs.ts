import {
  pgTable,
  text,
  boolean,
  date,
  timestamp,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const introductionRuns = pgTable(
  "introduction_runs",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull().unique(),
    source: text("source").notNull(), // "onboarding" | "recurring"
    cycleDate: date("cycle_date"),
    mode: text("mode").notNull(), // "preview" | "send" | "automated"
    dryRun: boolean("dry_run").notNull().default(false),
    status: text("status").notNull().default("planned"),
    // "planned" | "sending" | "completed" | "partial" | "failed" | "cancelled" | "expired"
    planHash: text("plan_hash"),
    dueOnly: boolean("due_only").default(false),
    initiatedBy: text("initiated_by"),
    summary: text("summary"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("intro_runs_request_id_idx").on(table.requestId),
    index("intro_runs_status_idx").on(table.status),
    index("intro_runs_created_at_idx").on(table.createdAt),
  ]
);

export type IntroductionRun = typeof introductionRuns.$inferSelect;
export type NewIntroductionRun = typeof introductionRuns.$inferInsert;
