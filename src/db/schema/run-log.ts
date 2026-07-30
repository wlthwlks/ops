import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";

// Converted from SQLite op_runs table. Serial PK preserved (integer sequence,
// no UUID needed here). Status enforced by application; add a CHECK constraint
// via a migration if stricter enforcement is required later.
export const opRuns = pgTable(
  "op_runs",
  {
    id: serial("id").primaryKey(),
    opSlug: text("op_slug").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull().default("running"),
    log: text("log").notNull().default(""),
    summary: text("summary"),
    variant: text("variant"),
    parametersJson: text("parameters_json"),
    progressCurrent: integer("progress_current"),
    progressTotal: integer("progress_total"),
    error: text("error"),
    operatorClerkUserId: text("operator_clerk_user_id"),
    runtimeMode: text("runtime_mode"),
    checkpointJson: text("checkpoint_json"),
    cancellationRequested: text("cancellation_requested").default("0"),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    index("op_runs_slug_started_idx").on(t.opSlug, t.startedAt),
    index("op_runs_status_idx").on(t.status),
  ]
);

export type OpRun = typeof opRuns.$inferSelect;
export type NewOpRun = typeof opRuns.$inferInsert;
