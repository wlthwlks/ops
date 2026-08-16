import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Reusable, named matching profiles for the unified introduction engine.
 * Scoring weights and matching constraints live on immutable
 * matching_profile_versions rows so every introduction run can be audited
 * against the exact configuration it used.
 */
export const matchingProfiles = pgTable(
  "matching_profiles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status").notNull().default("draft"),
    // "draft" | "active" | "archived"
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("matching_profiles_status_idx").on(table.status),
  ]
);

export type MatchingProfile = typeof matchingProfiles.$inferSelect;
export type NewMatchingProfile = typeof matchingProfiles.$inferInsert;
