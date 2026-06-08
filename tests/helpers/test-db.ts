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
export async function createTestDb(options?: { matchmake?: boolean }) {
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
      summary TEXT
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

  return {
    db: db as unknown as AppDb,
    async close() {
      await client.close();
    },
  };
}

export type TestDb = AppDb;
