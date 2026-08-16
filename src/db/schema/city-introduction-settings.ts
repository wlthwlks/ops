import {
  pgTable,
  text,
  boolean,
  integer,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-city configuration for the unified introduction engine.
 * Values stored here override the defaults from the city's matching profile
 * (or the global default profile) and from the email template.
 * `city_code` is the ALL CITIES record id.
 */
export const cityIntroductionSettings = pgTable(
  "city_introduction_settings",
  {
    id: text("id").primaryKey(),
    cityCode: text("city_code").notNull().unique(),
    cityName: text("city_name"),
    enabled: boolean("enabled").notNull().default(false),
    schedulingMode: text("scheduling_mode").notNull().default("manual"),
    // "manual" | "scheduled"
    scheduleJson: text("schedule_json"),
    // { dayOfMonth, localTime, timezone } for monthly scheduled runs
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    matchingProfileVersionId: text("matching_profile_version_id"),
    emailTemplateVersionId: text("email_template_version_id"),
    targetGroupSize: integer("target_group_size"),
    minGroupSize: integer("min_group_size"),
    maxGroupSize: integer("max_group_size"),
    strictGroupSize: boolean("strict_group_size"),
    requireSameCity: boolean("require_same_city"),
    maxDistanceKm: real("max_distance_km"),
    allowUnknownPostcode: boolean("allow_unknown_postcode"),
    repeatPairDays: integer("repeat_pair_days"),
    memberCooldownDays: integer("member_cooldown_days"),
    autoApprove: boolean("auto_approve").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("city_introduction_settings_enabled_idx").on(table.enabled),
    index("city_introduction_settings_next_run_idx").on(table.nextRunAt),
  ]
);

export type CityIntroductionSettings = typeof cityIntroductionSettings.$inferSelect;
export type NewCityIntroductionSettings = typeof cityIntroductionSettings.$inferInsert;
