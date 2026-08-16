import {
  pgTable,
  text,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Cached geographic coordinates per Airtable member, resolved from their
 * postcode/zip plus city via the Google geocoding integration. Coordinates
 * are only re-resolved when `location_hash` (derived from normalized
 * postcode + city) changes, so a matching run never calls Google repeatedly
 * for an unchanged location.
 */
export const memberGeoCache = pgTable(
  "member_geo_cache",
  {
    airtableRecordId: text("airtable_record_id").primaryKey(),
    email: text("email"),
    postcodeNormalized: text("postcode_normalized"),
    cityNormalized: text("city_normalized"),
    locationHash: text("location_hash"),
    lat: real("lat"),
    lon: real("lon"),
    displayName: text("display_name"),
    source: text("source").notNull().default("google"),
    // "google" | "airtable_city" | "manual"
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("member_geo_cache_email_idx").on(table.email),
    index("member_geo_cache_location_hash_idx").on(table.locationHash),
  ]
);

export type MemberGeoCache = typeof memberGeoCache.$inferSelect;
export type NewMemberGeoCache = typeof memberGeoCache.$inferInsert;
