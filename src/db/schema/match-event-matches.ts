import { pgTable, text, integer, real, boolean, index } from "drizzle-orm/pg-core";
import { matchEvents } from "./match-events";
import { members } from "./members";

export const matchEventMatches = pgTable(
  "match_event_matches",
  {
    id: text("id").primaryKey(),
    matchEventId: text("match_event_id")
      .notNull()
      .references(() => matchEvents.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    matchMemberId: text("match_member_id").references(() => members.id),
    matchEmail: text("match_email").notNull(),
    matchPostcode: text("match_postcode"),
    matchCity: text("match_city"),
    matchIndustry: text("match_industry"),
    similarityScore: real("similarity_score").notNull(),
    wasOnSlack: boolean("was_on_slack").notNull(),
  },
  (table) => [
    index("match_event_matches_event_id_idx").on(table.matchEventId),
    index("match_event_matches_email_idx").on(table.matchEmail),
    index("match_event_matches_postcode_idx").on(table.matchPostcode),
  ]
);

export type MatchEventMatch = typeof matchEventMatches.$inferSelect;
export type NewMatchEventMatch = typeof matchEventMatches.$inferInsert;
