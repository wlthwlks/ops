CREATE TABLE "introduction_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"source" text NOT NULL,
	"cycle_date" date,
	"mode" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"plan_hash" text,
	"due_only" boolean DEFAULT false,
	"initiated_by" text,
	"summary" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "introduction_runs_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "introduction_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source" text NOT NULL,
	"cycle_id" text,
	"channel_record_id" text,
	"city_record_id" text,
	"city_name" text,
	"slack_channel_id" text,
	"group_fingerprint" text NOT NULL,
	"delivery_key" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"message_snapshot" text,
	"slack_conversation_id" text,
	"slack_message_ts" text,
	"send_error" text,
	"tracking_error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "introduction_groups_delivery_key_unique" UNIQUE("delivery_key")
);
--> statement-breakpoint
CREATE TABLE "introduction_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"member_id" text,
	"airtable_record_id" text,
	"email_snapshot" text NOT NULL,
	"slack_user_id" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "introduction_reservations" (
	"member_key" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"source" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "introduction_groups" ADD CONSTRAINT "introduction_groups_run_id_introduction_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."introduction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_group_members" ADD CONSTRAINT "introduction_group_members_group_id_introduction_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."introduction_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_group_members" ADD CONSTRAINT "introduction_group_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "introduction_reservations" ADD CONSTRAINT "introduction_reservations_group_id_introduction_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."introduction_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intro_runs_request_id_idx" ON "introduction_runs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "intro_runs_status_idx" ON "introduction_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "intro_runs_created_at_idx" ON "introduction_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intro_groups_delivery_key_idx" ON "introduction_groups" USING btree ("delivery_key");--> statement-breakpoint
CREATE INDEX "intro_groups_fingerprint_idx" ON "introduction_groups" USING btree ("group_fingerprint");--> statement-breakpoint
CREATE INDEX "intro_groups_run_id_idx" ON "introduction_groups" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "intro_groups_cycle_id_idx" ON "introduction_groups" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "intro_groups_status_idx" ON "introduction_groups" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_group_airtable_idx" ON "introduction_group_members" USING btree ("group_id","airtable_record_id");--> statement-breakpoint
CREATE INDEX "group_members_group_id_idx" ON "introduction_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_members_email_idx" ON "introduction_group_members" USING btree ("email_snapshot");--> statement-breakpoint
CREATE INDEX "group_members_airtable_idx" ON "introduction_group_members" USING btree ("airtable_record_id");--> statement-breakpoint
CREATE INDEX "intro_reservations_expires_at_idx" ON "introduction_reservations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "intro_reservations_group_id_idx" ON "introduction_reservations" USING btree ("group_id");
