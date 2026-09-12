import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Mirror of a member's SweatPals membership (one row per SweatPals membership
 * item). SweatPals is the source of truth for membership state; this table is
 * the server-side cache we gate access against.
 *
 * `id` is SweatPals' own membership id (the `userToMembershipId` used by their
 * /fix-billing/{id} and /claim-membership/{id} links). It is the PRIMARY KEY:
 * upserts are keyed on it, so SweatPals state (active/paused/actualTo/…)
 * replaces the previous snapshot on every sync.
 *
 * `memberId` links to our `members.id` (Memberstack account id) once the
 * buyer is matched. It is nullable because a row can be created from the
 * SweatPals external API before our member linkage is confirmed.
 * `sweatpalsEmail` is the email as typed inside the SweatPals checkout —
 * it is the authoritative lookup key for the external API.
 */
export const sweatpalsMemberships = pgTable(
  "sweatpals_memberships",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id"),
    membershipId: text("membership_id"),
    membershipTierId: text("membership_tier_id"),
    membershipName: text("membership_name"),
    active: boolean("active").notNull().default(false),
    paused: boolean("paused").notNull().default(false),
    pauseFuturePayments: boolean("pause_future_payments").notNull().default(false),
    isClaimed: boolean("is_claimed").notNull().default(false),
    actualFrom: timestamp("actual_from", { withTimezone: true }),
    actualTo: timestamp("actual_to", { withTimezone: true }),
    expireDate: timestamp("expire_date", { withTimezone: true }),
    cancellationEffectiveAt: timestamp("cancellation_effective_at", {
      withTimezone: true,
    }),
    sweatpalsEmail: text("sweatpals_email"),
    sweatpalsPhone: text("sweatpals_phone"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("sweatpals_memberships_member_id_idx").on(t.memberId),
    index("sweatpals_memberships_email_idx").on(t.sweatpalsEmail),
    index("sweatpals_memberships_last_synced_idx").on(t.lastSyncedAt),
  ]
);

export type SweatpalsMembership = typeof sweatpalsMemberships.$inferSelect;
export type NewSweatpalsMembership = typeof sweatpalsMemberships.$inferInsert;
