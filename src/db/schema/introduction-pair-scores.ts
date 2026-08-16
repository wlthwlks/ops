import {
  pgTable,
  text,
  real,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { introductionRuns } from "./introduction-runs";

/**
 * Per-pair score snapshots for an introduction run. `scores_json` holds the
 * normalized 0-1 breakdown per score component (proximity, ai_correlation,
 * help_expertise, goal_relevance, connection_type, industry, business_stage)
 * and `overall` is the weighted combination. These snapshots make every run
 * explainable and reproducible even if profiles/embeddings change later.
 */
export const introductionPairScores = pgTable(
  "introduction_pair_scores",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => introductionRuns.id),
    memberAKey: text("member_a_key").notNull(),
    memberBKey: text("member_b_key").notNull(),
    pairKey: text("pair_key").notNull(),
    scoresJson: text("scores_json").notNull(),
    overall: real("overall").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("intro_pair_scores_run_pair_uidx").on(table.runId, table.pairKey),
    index("intro_pair_scores_run_idx").on(table.runId),
    index("intro_pair_scores_member_idx").on(table.memberAKey),
  ]
);

export type IntroductionPairScore = typeof introductionPairScores.$inferSelect;
export type NewIntroductionPairScore = typeof introductionPairScores.$inferInsert;
