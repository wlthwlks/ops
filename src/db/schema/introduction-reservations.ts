import {
  pgTable,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { introductionGroups } from "./introduction-groups";

export const introductionReservations = pgTable(
  "introduction_reservations",
  {
    memberKey: text("member_key").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => introductionGroups.id),
    source: text("source").notNull(), // "onboarding" | "recurring"
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("intro_reservations_expires_at_idx").on(table.expiresAt),
    index("intro_reservations_group_id_idx").on(table.groupId),
  ]
);

export type IntroductionReservation = typeof introductionReservations.$inferSelect;
export type NewIntroductionReservation = typeof introductionReservations.$inferInsert;
