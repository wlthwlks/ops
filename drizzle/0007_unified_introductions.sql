CREATE TABLE "city_introduction_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"city_code" text NOT NULL,
	"city_name" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"scheduling_mode" text DEFAULT 'manual' NOT NULL,
	"schedule_json" text,
	"next_run_at" timestamp with time zone,
	"matching_profile_version_id" text,
	"email_template_version_id" text,
	"target_group_size" integer,
	"min_group_size" integer,
	"max_group_size" integer,
	"strict_group_size" boolean,
	"require_same_city" boolean,
	"max_distance_km" real,
	"allow_unknown_postcode" boolean,
	"repeat_pair_days" integer,
	"member_cooldown_days" integer,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "city_introduction_settings_city_code_unique" UNIQUE("city_code")
);
--> statement-breakpoint
CREATE TABLE "matching_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_profile_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"weights_json" text NOT NULL,
	"constraints_json" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "introduction_email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "introduction_email_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"sender_from" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "introduction_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_geo_cache" (
	"airtable_record_id" text PRIMARY KEY NOT NULL,
	"email" text,
	"postcode_normalized" text,
	"city_normalized" text,
	"location_hash" text,
	"lat" real,
	"lon" real,
	"display_name" text,
	"source" text DEFAULT 'google' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "introduction_member_profiles" (
	"airtable_record_id" text PRIMARY KEY NOT NULL,
	"email" text,
	"profile_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "introduction_pair_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"member_a_key" text NOT NULL,
	"member_b_key" text NOT NULL,
	"pair_key" text NOT NULL,
	"scores_json" text NOT NULL,
	"overall" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "introduction_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"group_id" text NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_name" text,
	"airtable_record_id" text,
	"original_to_json" text,
	"deliver_to_email" text NOT NULL,
	"delivery_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resend_message_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"error" text,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "introduction_deliveries_delivery_key_unique" UNIQUE("delivery_key")
);
--> statement-breakpoint
CREATE TABLE "introduction_delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_event_id" text DEFAULT '' NOT NULL,
	"provider_ts" timestamp with time zone,
	"payload_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "matching_profile_version_id" text;--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "email_template_version_id" text;--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "city_codes_json" text;--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "delivery_mode" text DEFAULT 'simulation' NOT NULL;--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "snapshot_json" text;--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "created_by_clerk_user_id" text;--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "total_groups" integer;--> statement-breakpoint
ALTER TABLE "introduction_runs" ADD COLUMN "total_deliveries" integer;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "overall_score" real;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "score_breakdown_json" text;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "matching_profile_version_id" text;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "city_code" text;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "email_subject_snapshot" text;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "email_html_snapshot" text;--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "introduction_group_members" ADD COLUMN "member_snapshot_json" text;--> statement-breakpoint
ALTER TABLE "matching_profile_versions" ADD CONSTRAINT "matching_profile_versions_profile_id_matching_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."matching_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_email_template_versions" ADD CONSTRAINT "introduction_email_template_versions_template_id_introduction_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."introduction_email_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_pair_scores" ADD CONSTRAINT "introduction_pair_scores_run_id_introduction_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."introduction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_deliveries" ADD CONSTRAINT "introduction_deliveries_run_id_introduction_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."introduction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_deliveries" ADD CONSTRAINT "introduction_deliveries_group_id_introduction_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."introduction_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_delivery_events" ADD CONSTRAINT "introduction_delivery_events_delivery_id_introduction_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."introduction_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "city_introduction_settings_enabled_idx" ON "city_introduction_settings" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "city_introduction_settings_next_run_idx" ON "city_introduction_settings" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "matching_profiles_status_idx" ON "matching_profiles" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_profile_versions_profile_version_uidx" ON "matching_profile_versions" USING btree ("profile_id","version");--> statement-breakpoint
CREATE INDEX "matching_profile_versions_profile_idx" ON "matching_profile_versions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "introduction_email_templates_status_idx" ON "introduction_email_templates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "introduction_email_template_versions_uidx" ON "introduction_email_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "introduction_email_template_versions_template_idx" ON "introduction_email_template_versions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "member_geo_cache_email_idx" ON "member_geo_cache" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_geo_cache_location_hash_idx" ON "member_geo_cache" USING btree ("location_hash");--> statement-breakpoint
CREATE INDEX "introduction_member_profiles_email_idx" ON "introduction_member_profiles" USING btree ("email");--> statement-breakpoint
CREATE INDEX "introduction_member_profiles_status_idx" ON "introduction_member_profiles" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "intro_pair_scores_run_pair_uidx" ON "introduction_pair_scores" USING btree ("run_id","pair_key");--> statement-breakpoint
CREATE INDEX "intro_pair_scores_run_idx" ON "introduction_pair_scores" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "intro_pair_scores_member_idx" ON "introduction_pair_scores" USING btree ("member_a_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intro_deliveries_delivery_key_idx" ON "introduction_deliveries" USING btree ("delivery_key");--> statement-breakpoint
CREATE INDEX "intro_deliveries_run_idx" ON "introduction_deliveries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "intro_deliveries_group_idx" ON "introduction_deliveries" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "intro_deliveries_status_idx" ON "introduction_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "intro_deliveries_resend_msg_idx" ON "introduction_deliveries" USING btree ("resend_message_id");--> statement-breakpoint
CREATE INDEX "intro_deliveries_recipient_idx" ON "introduction_deliveries" USING btree ("recipient_email");--> statement-breakpoint
CREATE INDEX "intro_deliveries_next_retry_idx" ON "introduction_deliveries" USING btree ("next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intro_delivery_events_uidx" ON "introduction_delivery_events" USING btree ("delivery_id","event_type","provider_event_id");--> statement-breakpoint
CREATE INDEX "intro_delivery_events_delivery_idx" ON "introduction_delivery_events" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "intro_delivery_events_type_idx" ON "introduction_delivery_events" USING btree ("event_type");