CREATE TABLE "email_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"match_event_id" text NOT NULL,
	"chaser_id" text,
	"recipient_email" text NOT NULL,
	"recipient_role" text NOT NULL,
	"resend_message_id" text,
	"status" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"airtable_record_id" text,
	"pinecone_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"initiated_by" text,
	"mode" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"new_member_id" text,
	"new_member_email" text NOT NULL,
	"new_member_postcode" text,
	"new_member_city" text,
	"new_member_industry" text,
	"summary" text,
	"error" text,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"slack_sent_at" timestamp with time zone,
	"slack_recipient_count" integer,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "match_events_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "match_event_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"match_event_id" text NOT NULL,
	"rank" integer NOT NULL,
	"match_member_id" text,
	"match_email" text NOT NULL,
	"match_postcode" text,
	"match_city" text,
	"match_industry" text,
	"similarity_score" real NOT NULL,
	"was_on_slack" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "op_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"op_slug" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"summary" text
);
--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_match_event_id_match_events_id_fk" FOREIGN KEY ("match_event_id") REFERENCES "public"."match_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_new_member_id_members_id_fk" FOREIGN KEY ("new_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_event_matches" ADD CONSTRAINT "match_event_matches_match_event_id_match_events_id_fk" FOREIGN KEY ("match_event_id") REFERENCES "public"."match_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_event_matches" ADD CONSTRAINT "match_event_matches_match_member_id_members_id_fk" FOREIGN KEY ("match_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_deliveries_resend_msg_id_idx" ON "email_deliveries" USING btree ("resend_message_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_recipient_sent_at_idx" ON "email_deliveries" USING btree ("recipient_email","sent_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_match_event_id_idx" ON "email_deliveries" USING btree ("match_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_email_idx" ON "members" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "match_events_request_id_idx" ON "match_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "match_events_created_at_idx" ON "match_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "match_events_new_member_email_idx" ON "match_events" USING btree ("new_member_email");--> statement-breakpoint
CREATE INDEX "match_events_city_created_at_idx" ON "match_events" USING btree ("new_member_city","created_at");--> statement-breakpoint
CREATE INDEX "match_event_matches_event_id_idx" ON "match_event_matches" USING btree ("match_event_id");--> statement-breakpoint
CREATE INDEX "match_event_matches_email_idx" ON "match_event_matches" USING btree ("match_email");--> statement-breakpoint
CREATE INDEX "match_event_matches_postcode_idx" ON "match_event_matches" USING btree ("match_postcode");