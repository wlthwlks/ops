import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const formAnalyticsEvents = pgTable(
  "form_analytics_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    sessionId: text("session_id"),
    memberstackId: text("memberstack_id"),
    airtableRecordId: text("airtable_record_id"),
    stage: text("stage"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("form_analytics_events_type_idx").on(t.eventType),
    index("form_analytics_events_created_idx").on(t.createdAt),
  ]
);

export type FormAnalyticsEvent = typeof formAnalyticsEvents.$inferSelect;
