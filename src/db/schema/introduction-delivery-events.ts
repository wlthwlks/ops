import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { introductionDeliveries } from "./introduction-deliveries";

/**
 * Verified provider webhook events (Resend) for introduction deliveries.
 * `provider_ts` is the provider event timestamp and guards against
 * out-of-order webhook arrival; the unique index makes processing idempotent.
 */
export const introductionDeliveryEvents = pgTable(
  "introduction_delivery_events",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => introductionDeliveries.id),
    eventType: text("event_type").notNull(),
    // "sent" | "delivered" | "delayed" | "bounced" | "complained" |
    // "failed" | "suppressed" | "opened" | "clicked"
    providerEventId: text("provider_event_id").notNull().default(""),
    providerTs: timestamp("provider_ts", { withTimezone: true }),
    payloadJson: text("payload_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("intro_delivery_events_uidx")
      .on(table.deliveryId, table.eventType, table.providerEventId),
    index("intro_delivery_events_delivery_idx").on(table.deliveryId),
    index("intro_delivery_events_type_idx").on(table.eventType),
  ]
);

export type IntroductionDeliveryEvent = typeof introductionDeliveryEvents.$inferSelect;
export type NewIntroductionDeliveryEvent = typeof introductionDeliveryEvents.$inferInsert;
