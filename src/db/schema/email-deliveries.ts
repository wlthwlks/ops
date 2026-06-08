import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { matchEvents } from "./match-events";

export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: text("id").primaryKey(),
    matchEventId: text("match_event_id")
      .notNull()
      .references(() => matchEvents.id, { onDelete: "cascade" }),
    // chaser_id: FK target table (chasers) not yet defined — Phase 2 will add the FK constraint
    chaserId: text("chaser_id"),
    recipientEmail: text("recipient_email").notNull(),
    recipientRole: text("recipient_role").notNull(),
    resendMessageId: text("resend_message_id"),
    status: text("status").notNull(),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  },
  (table) => [
    index("email_deliveries_resend_msg_id_idx").on(table.resendMessageId),
    index("email_deliveries_recipient_sent_at_idx").on(
      table.recipientEmail,
      table.sentAt
    ),
    index("email_deliveries_match_event_id_idx").on(table.matchEventId),
  ]
);

export type EmailDelivery = typeof emailDeliveries.$inferSelect;
export type NewEmailDelivery = typeof emailDeliveries.$inferInsert;
