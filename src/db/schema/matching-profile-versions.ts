import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { matchingProfiles } from "./matching-profiles";

/**
 * Immutable versions of a matching profile. `weights_json` stores the raw
 * admin-configured weight values per score component (normalized to sum to 1
 * at scoring time); `constraints_json` stores the hard constraints
 * (require_same_city, max_distance_km, allow_unknown_postcode,
 * repeat_pair_days, member_cooldown_days, group sizes, strict group size).
 */
export const matchingProfileVersions = pgTable(
  "matching_profile_versions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => matchingProfiles.id),
    version: integer("version").notNull(),
    weightsJson: text("weights_json").notNull(),
    constraintsJson: text("constraints_json").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("matching_profile_versions_profile_version_uidx")
      .on(table.profileId, table.version),
    index("matching_profile_versions_profile_idx").on(table.profileId),
  ]
);

export type MatchingProfileVersion = typeof matchingProfileVersions.$inferSelect;
export type NewMatchingProfileVersion = typeof matchingProfileVersions.$inferInsert;
