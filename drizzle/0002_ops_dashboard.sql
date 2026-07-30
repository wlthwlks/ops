CREATE TABLE "member_outreach" (
	"id" text PRIMARY KEY NOT NULL,
	"airtable_record_id" text NOT NULL,
	"stripe_customer_id" text,
	"recipient_email" text NOT NULL,
	"outreach_type" text NOT NULL,
	"city" text,
	"city_channel_id" text,
	"all_members_channel_id" text,
	"status" text NOT NULL,
	"resend_message_id" text,
	"error" text,
	"sent_by_clerk_user_id" text,
	"runtime_mode" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "member_outreach_idempotency_uidx" ON "member_outreach" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "member_outreach_airtable_idx" ON "member_outreach" USING btree ("airtable_record_id");
--> statement-breakpoint
CREATE INDEX "member_outreach_recipient_idx" ON "member_outreach" USING btree ("recipient_email","created_at");
--> statement-breakpoint
CREATE INDEX "member_outreach_type_status_idx" ON "member_outreach" USING btree ("outreach_type","status");
--> statement-breakpoint
CREATE TABLE "ops_scan_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_type" text NOT NULL,
	"status" text NOT NULL,
	"summary_json" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_clerk_user_id" text
);
--> statement-breakpoint
CREATE INDEX "ops_scan_snapshots_type_created_idx" ON "ops_scan_snapshots" USING btree ("scan_type","created_at");
