import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";

/**
 * Spin up an embedded Postgres (PGlite, WASM) per test, with the op_runs
 * table created so existing schema-touching tests work without a network DB.
 *
 * Returns a drizzle client typed as the production AppDb (NeonHttpDatabase)
 * for assignment compatibility — at runtime PGlite implements the same
 * PgDatabase interface that production code consumes.
 *
 * Pass `{ matchmake: true }` to also create the matchmake tables
 * (members, match_events, match_event_matches, email_deliveries).
 * The opt-in keeps the existing op_runs-only tests fast.
 */
export async function createTestDb(options?: { matchmake?: boolean; introduction?: boolean; signupCreations?: boolean }) {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await client.exec(`
    CREATE TABLE op_runs (
      id SERIAL PRIMARY KEY,
      op_slug TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      log TEXT NOT NULL DEFAULT '',
      summary TEXT,
      variant TEXT,
      parameters_json TEXT,
      progress_current INTEGER,
      progress_total INTEGER,
      error TEXT,
      operator_clerk_user_id TEXT,
      runtime_mode TEXT,
      checkpoint_json TEXT,
      cancellation_requested TEXT DEFAULT '0',
      idempotency_key TEXT
    );
  `);

  if (options?.matchmake) {
    await client.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL,
        airtable_record_id TEXT,
        pinecone_id TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT members_email_unique UNIQUE (email)
      );

      CREATE UNIQUE INDEX members_email_idx ON members (email);

      CREATE TABLE match_events (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        initiated_by TEXT,
        mode TEXT NOT NULL,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        new_member_id TEXT,
        new_member_email TEXT NOT NULL,
        new_member_postcode TEXT,
        new_member_city TEXT,
        new_member_industry TEXT,
        summary TEXT,
        error TEXT,
        slack_channel_id TEXT,
        slack_message_ts TEXT,
        slack_sent_at TIMESTAMPTZ,
        slack_recipient_count INTEGER,
        deleted_at TIMESTAMPTZ,
        CONSTRAINT match_events_request_id_unique UNIQUE (request_id)
      );

      CREATE UNIQUE INDEX match_events_request_id_idx ON match_events (request_id);
      CREATE INDEX match_events_created_at_idx ON match_events (created_at);
      CREATE INDEX match_events_new_member_email_idx ON match_events (new_member_email);

      ALTER TABLE match_events
        ADD CONSTRAINT match_events_new_member_id_members_id_fk
        FOREIGN KEY (new_member_id) REFERENCES members (id);

      CREATE TABLE match_event_matches (
        id TEXT PRIMARY KEY NOT NULL,
        match_event_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        match_member_id TEXT,
        match_email TEXT NOT NULL,
        match_postcode TEXT,
        match_city TEXT,
        match_industry TEXT,
        similarity_score REAL NOT NULL,
        was_on_slack BOOLEAN NOT NULL
      );

      CREATE INDEX match_event_matches_event_id_idx ON match_event_matches (match_event_id);
      CREATE INDEX match_event_matches_email_idx ON match_event_matches (match_email);
      CREATE INDEX match_event_matches_postcode_idx ON match_event_matches (match_postcode);

      ALTER TABLE match_event_matches
        ADD CONSTRAINT match_event_matches_match_event_id_fk
        FOREIGN KEY (match_event_id) REFERENCES match_events (id) ON DELETE CASCADE;

      ALTER TABLE match_event_matches
        ADD CONSTRAINT match_event_matches_match_member_id_fk
        FOREIGN KEY (match_member_id) REFERENCES members (id);

      CREATE TABLE email_deliveries (
        id TEXT PRIMARY KEY NOT NULL,
        match_event_id TEXT NOT NULL,
        chaser_id TEXT,
        recipient_email TEXT NOT NULL,
        recipient_role TEXT NOT NULL,
        resend_message_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_event_at TIMESTAMPTZ
      );

      CREATE INDEX email_deliveries_resend_msg_id_idx ON email_deliveries (resend_message_id);
      CREATE INDEX email_deliveries_match_event_id_idx ON email_deliveries (match_event_id);

      ALTER TABLE email_deliveries
        ADD CONSTRAINT email_deliveries_match_event_id_fk
        FOREIGN KEY (match_event_id) REFERENCES match_events (id) ON DELETE CASCADE;
    `);
  }

  if (options?.introduction) {
    await client.exec(`
      CREATE TABLE introduction_runs (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL,
        source TEXT NOT NULL,
        cycle_date DATE,
        mode TEXT NOT NULL,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'planned',
        plan_hash TEXT,
        due_only BOOLEAN DEFAULT FALSE,
        initiated_by TEXT,
        summary TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        CONSTRAINT introduction_runs_request_id_unique UNIQUE (request_id)
      );

      CREATE TABLE introduction_groups (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        cycle_id TEXT,
        channel_record_id TEXT,
        city_record_id TEXT,
        city_name TEXT,
        slack_channel_id TEXT,
        group_fingerprint TEXT NOT NULL,
        delivery_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'planned',
        message_snapshot TEXT,
        slack_conversation_id TEXT,
        slack_message_ts TEXT,
        send_error TEXT,
        tracking_error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      );

      CREATE TABLE introduction_group_members (
        id TEXT PRIMARY KEY NOT NULL,
        group_id TEXT NOT NULL,
        member_id TEXT,
        airtable_record_id TEXT,
        email_snapshot TEXT NOT NULL,
        slack_user_id TEXT,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE introduction_reservations (
        member_key TEXT PRIMARY KEY NOT NULL,
        group_id TEXT NOT NULL,
        source TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX intro_runs_request_id_idx ON introduction_runs (request_id);
      CREATE INDEX intro_groups_fingerprint_idx ON introduction_groups (group_fingerprint);
      CREATE UNIQUE INDEX group_members_group_airtable_idx ON introduction_group_members (group_id, airtable_record_id);
      CREATE INDEX intro_reservations_expires_at_idx ON introduction_reservations (expires_at);

      ALTER TABLE introduction_groups
        ADD CONSTRAINT intro_groups_run_id_fk
        FOREIGN KEY (run_id) REFERENCES introduction_runs (id);

      ALTER TABLE introduction_group_members
        ADD CONSTRAINT intro_group_members_group_id_fk
        FOREIGN KEY (group_id) REFERENCES introduction_groups (id) ON DELETE CASCADE;

      ALTER TABLE introduction_reservations
        ADD CONSTRAINT intro_reservations_group_id_fk
        FOREIGN KEY (group_id) REFERENCES introduction_groups (id);
    `);
  }

  if (options?.signupCreations) {
    await client.exec(`
      CREATE TABLE signup_member_creations (
        memberstack_id TEXT PRIMARY KEY NOT NULL,
        email_normalized TEXT NOT NULL,
        status TEXT DEFAULT 'CREATING' NOT NULL,
        created_by TEXT NOT NULL,
        airtable_record_id TEXT,
        attempt_count INTEGER DEFAULT 1 NOT NULL,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX signup_member_creations_ms_id_uidx ON signup_member_creations (memberstack_id);
      CREATE INDEX signup_member_creations_email_idx ON signup_member_creations (email_normalized);
      CREATE INDEX signup_member_creations_status_idx ON signup_member_creations (status);
    `);
  }

  return {
    db: db as unknown as AppDb,
    async close() {
      await client.close();
    },
  };
}

export type TestDb = AppDb;
