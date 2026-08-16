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
 * Pass `{ introduction: true }` for the original introduction ledger tables.
 * Pass `{ introductionsV2: true }` for the unified introduction engine
 * tables (creates the base ledger tables plus matching profiles,
 * city settings, email templates, config, geo cache, member profiles,
 * pair scores, deliveries and delivery events).
 * The opt-in keeps the existing op_runs-only tests fast.
 */
export async function createTestDb(options?: { matchmake?: boolean; introduction?: boolean; introductionsV2?: boolean; signupCreations?: boolean }) {
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

  if (options?.introduction || options?.introductionsV2) {
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
        matching_profile_version_id TEXT,
        email_template_version_id TEXT,
        city_codes_json TEXT,
        delivery_mode TEXT NOT NULL DEFAULT 'simulation',
        snapshot_json TEXT,
        created_by_clerk_user_id TEXT,
        total_groups INTEGER,
        total_deliveries INTEGER,
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
        sent_at TIMESTAMPTZ,
        overall_score REAL,
        score_breakdown_json TEXT,
        matching_profile_version_id TEXT,
        city_code TEXT,
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        email_subject_snapshot TEXT,
        email_html_snapshot TEXT,
        claimed_at TIMESTAMPTZ
      );

      CREATE TABLE introduction_group_members (
        id TEXT PRIMARY KEY NOT NULL,
        group_id TEXT NOT NULL,
        member_id TEXT,
        airtable_record_id TEXT,
        email_snapshot TEXT NOT NULL,
        slack_user_id TEXT,
        role TEXT NOT NULL,
        member_snapshot_json TEXT,
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

  if (options?.introductionsV2) {
    await client.exec(`
      CREATE TABLE matching_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX matching_profiles_status_idx ON matching_profiles (status);

      CREATE TABLE matching_profile_versions (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        weights_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX matching_profile_versions_profile_version_uidx
        ON matching_profile_versions (profile_id, version);
      CREATE INDEX matching_profile_versions_profile_idx
        ON matching_profile_versions (profile_id);

      ALTER TABLE matching_profile_versions
        ADD CONSTRAINT matching_profile_versions_profile_id_fk
        FOREIGN KEY (profile_id) REFERENCES matching_profiles (id);

      CREATE TABLE city_introduction_settings (
        id TEXT PRIMARY KEY NOT NULL,
        city_code TEXT NOT NULL,
        city_name TEXT,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        scheduling_mode TEXT NOT NULL DEFAULT 'manual',
        schedule_json TEXT,
        next_run_at TIMESTAMPTZ,
        matching_profile_version_id TEXT,
        email_template_version_id TEXT,
        target_group_size INTEGER,
        min_group_size INTEGER,
        max_group_size INTEGER,
        strict_group_size BOOLEAN,
        require_same_city BOOLEAN,
        max_distance_km REAL,
        allow_unknown_postcode BOOLEAN,
        repeat_pair_days INTEGER,
        member_cooldown_days INTEGER,
        auto_approve BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT city_introduction_settings_city_code_unique UNIQUE (city_code)
      );

      CREATE INDEX city_introduction_settings_enabled_idx ON city_introduction_settings (enabled);
      CREATE INDEX city_introduction_settings_next_run_idx ON city_introduction_settings (next_run_at);

      CREATE TABLE introduction_email_templates (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX introduction_email_templates_status_idx ON introduction_email_templates (status);

      CREATE TABLE introduction_email_template_versions (
        id TEXT PRIMARY KEY NOT NULL,
        template_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        subject TEXT NOT NULL,
        body_html TEXT NOT NULL,
        sender_from TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX introduction_email_template_versions_uidx
        ON introduction_email_template_versions (template_id, version);
      CREATE INDEX introduction_email_template_versions_template_idx
        ON introduction_email_template_versions (template_id);

      ALTER TABLE introduction_email_template_versions
        ADD CONSTRAINT introduction_email_template_versions_template_id_fk
        FOREIGN KEY (template_id) REFERENCES introduction_email_templates (id);

      CREATE TABLE introduction_config (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE member_geo_cache (
        airtable_record_id TEXT PRIMARY KEY NOT NULL,
        email TEXT,
        postcode_normalized TEXT,
        city_normalized TEXT,
        location_hash TEXT,
        lat REAL,
        lon REAL,
        display_name TEXT,
        source TEXT NOT NULL DEFAULT 'google',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX member_geo_cache_email_idx ON member_geo_cache (email);
      CREATE INDEX member_geo_cache_location_hash_idx ON member_geo_cache (location_hash);

      CREATE TABLE introduction_member_profiles (
        airtable_record_id TEXT PRIMARY KEY NOT NULL,
        email TEXT,
        profile_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        last_synced_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX introduction_member_profiles_email_idx ON introduction_member_profiles (email);
      CREATE INDEX introduction_member_profiles_status_idx ON introduction_member_profiles (status);

      CREATE TABLE introduction_pair_scores (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        member_a_key TEXT NOT NULL,
        member_b_key TEXT NOT NULL,
        pair_key TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        overall REAL NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX intro_pair_scores_run_pair_uidx ON introduction_pair_scores (run_id, pair_key);
      CREATE INDEX intro_pair_scores_run_idx ON introduction_pair_scores (run_id);
      CREATE INDEX intro_pair_scores_member_idx ON introduction_pair_scores (member_a_key);

      ALTER TABLE introduction_pair_scores
        ADD CONSTRAINT introduction_pair_scores_run_id_fk
        FOREIGN KEY (run_id) REFERENCES introduction_runs (id);

      CREATE TABLE introduction_deliveries (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        recipient_name TEXT,
        airtable_record_id TEXT,
        original_to_json TEXT,
        deliver_to_email TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        resend_message_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        last_event_at TIMESTAMPTZ,
        error TEXT,
        sent_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT introduction_deliveries_delivery_key_unique UNIQUE (delivery_key)
      );

      CREATE UNIQUE INDEX intro_deliveries_delivery_key_idx ON introduction_deliveries (delivery_key);
      CREATE INDEX intro_deliveries_run_idx ON introduction_deliveries (run_id);
      CREATE INDEX intro_deliveries_group_idx ON introduction_deliveries (group_id);
      CREATE INDEX intro_deliveries_status_idx ON introduction_deliveries (status);
      CREATE INDEX intro_deliveries_resend_msg_idx ON introduction_deliveries (resend_message_id);
      CREATE INDEX intro_deliveries_recipient_idx ON introduction_deliveries (recipient_email);
      CREATE INDEX intro_deliveries_next_retry_idx ON introduction_deliveries (next_retry_at);

      ALTER TABLE introduction_deliveries
        ADD CONSTRAINT introduction_deliveries_run_id_fk
        FOREIGN KEY (run_id) REFERENCES introduction_runs (id);

      ALTER TABLE introduction_deliveries
        ADD CONSTRAINT introduction_deliveries_group_id_fk
        FOREIGN KEY (group_id) REFERENCES introduction_groups (id);

      CREATE TABLE introduction_delivery_events (
        id TEXT PRIMARY KEY NOT NULL,
        delivery_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        provider_event_id TEXT NOT NULL DEFAULT '',
        provider_ts TIMESTAMPTZ,
        payload_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX intro_delivery_events_uidx
        ON introduction_delivery_events (delivery_id, event_type, provider_event_id);
      CREATE INDEX intro_delivery_events_delivery_idx ON introduction_delivery_events (delivery_id);
      CREATE INDEX intro_delivery_events_type_idx ON introduction_delivery_events (event_type);

      ALTER TABLE introduction_delivery_events
        ADD CONSTRAINT introduction_delivery_events_delivery_id_fk
        FOREIGN KEY (delivery_id) REFERENCES introduction_deliveries (id);
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

/**
 * Delete every row from the unified introduction engine tables (and the
 * base introduction ledger tables) in FK-safe order. Useful in before/between
 * tests that share one PGlite instance.
 */
export async function resetIntroductionsV2Tables(db: AppDb) {
  await db.delete(schema.introductionDeliveryEvents);
  await db.delete(schema.introductionDeliveries);
  await db.delete(schema.introductionPairScores);
  await db.delete(schema.introductionReservations);
  await db.delete(schema.introductionGroupMembers);
  await db.delete(schema.introductionGroups);
  await db.delete(schema.introductionRuns);
  await db.delete(schema.matchingProfileVersions);
  await db.delete(schema.matchingProfiles);
  await db.delete(schema.introductionEmailTemplateVersions);
  await db.delete(schema.introductionEmailTemplates);
  await db.delete(schema.cityIntroductionSettings);
  await db.delete(schema.introductionConfig);
  await db.delete(schema.memberGeoCache);
  await db.delete(schema.introductionMemberProfiles);
}
