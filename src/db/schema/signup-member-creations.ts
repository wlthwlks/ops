import {
  pgTable,
  text,
  timestamp,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Idempotency / lock table for initial Airtable Member creation during signup.
 *
 * Only one row should ever exist per `memberstack_id` (PRIMARY KEY). The first
 * caller to INSERT wins and becomes the canonical creator of the Airtable
 * Member record for that member. All other concurrent callers (the
 * Memberstack webhook arriving before/during `/api/onboarding/bootstrap`, or
 * duplicate redeliveries) see the existing row and either:
 *   - reconcile an already-created Airtable record, or
 *   - briefly poll for `airtable_record_id` and defer if still missing.
 *
 * `email_normalized` is stored as a secondary recovery identity and indexed
 * for diagnostic queries. It is deliberately NOT unique-constrained here:
 * identity conflicts are surfaced against Airtable (where the user's data
 * lives) and reported as `MEMBER_IDENTITY_CONFLICT`, not silently rejected by
 * the lock table itself.
 *
 * Lifecycle:
 *   CREATING  -> creator is performing the Airtable create (or polling)
 *   CREATED   -> airtable_record_id populated; safe to reconcile / re-create
 *   FAILED    -> creator threw before populating airtable_record_id; a later
 *                caller may steal a stale FAILED/CREATING row (see lock module).
 */
export const signupMemberCreations = pgTable(
  "signup_member_creations",
  {
    memberstackId: text("memberstack_id").primaryKey(),
    emailNormalized: text("email_normalized").notNull(),
    status: text("status").notNull().default("CREATING"),
    createdBy: text("created_by").notNull(),
    airtableRecordId: text("airtable_record_id"),
    attemptCount: integer("attempt_count").notNull().default(1),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("signup_member_creations_ms_id_uidx").on(t.memberstackId),
    index("signup_member_creations_email_idx").on(t.emailNormalized),
    index("signup_member_creations_status_idx").on(t.status),
  ]
);

export type SignupMemberCreation = typeof signupMemberCreations.$inferSelect;
export type NewSignupMemberCreation = typeof signupMemberCreations.$inferInsert;