import {
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Global key/value configuration for the unified introduction engine.
 * Keys include the default matching profile, default email template,
 * sender identity, canary recipient addresses and provider-test recipient
 * addresses. Values are JSON strings.
 */
export const introductionConfig = pgTable("introduction_config", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type IntroductionConfig = typeof introductionConfig.$inferSelect;
export type NewIntroductionConfig = typeof introductionConfig.$inferInsert;
