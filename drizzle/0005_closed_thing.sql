CREATE TABLE "form_analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"session_id" text,
	"memberstack_id" text,
	"airtable_record_id" text,
	"stage" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"metadata_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "slack_access_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"action_type" text NOT NULL,
	"airtable_record_id" text,
	"slack_user_id" text,
	"target_channel_ids" text,
	"status" text NOT NULL,
	"result_json" text,
	"error" text,
	"initiated_by_clerk_user_id" text,
	"runtime_mode" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"livemode" boolean DEFAULT false NOT NULL,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"payload_hash" text,
	"sanitized_payload" text,
	"memberstack_id" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"airtable_record_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"error_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"public_error_code" text NOT NULL,
	"source" text NOT NULL,
	"operation" text NOT NULL,
	"severity" text DEFAULT 'error' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"details" text,
	"stack_trace" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"memberstack_id" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"airtable_record_id" text,
	"webhook_event_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "parameters_json" text;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "progress_current" integer;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "progress_total" integer;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "operator_clerk_user_id" text;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "runtime_mode" text;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "checkpoint_json" text;--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "cancellation_requested" text DEFAULT '0';--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE INDEX "form_analytics_events_type_idx" ON "form_analytics_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "form_analytics_events_created_idx" ON "form_analytics_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "member_outreach_idempotency_uidx" ON "member_outreach" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "member_outreach_airtable_idx" ON "member_outreach" USING btree ("airtable_record_id");--> statement-breakpoint
CREATE INDEX "member_outreach_recipient_idx" ON "member_outreach" USING btree ("recipient_email","created_at");--> statement-breakpoint
CREATE INDEX "member_outreach_type_status_idx" ON "member_outreach" USING btree ("outreach_type","status");--> statement-breakpoint
CREATE INDEX "ops_scan_snapshots_type_created_idx" ON "ops_scan_snapshots" USING btree ("scan_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_access_actions_idempotency_uidx" ON "slack_access_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "slack_access_actions_airtable_idx" ON "slack_access_actions" USING btree ("airtable_record_id");--> statement-breakpoint
CREATE INDEX "slack_access_actions_status_idx" ON "slack_access_actions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uidx" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_events_type_idx" ON "webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "integration_errors_status_idx" ON "integration_errors" USING btree ("status");--> statement-breakpoint
CREATE INDEX "integration_errors_code_idx" ON "integration_errors" USING btree ("public_error_code");--> statement-breakpoint
CREATE INDEX "integration_errors_source_idx" ON "integration_errors" USING btree ("source");--> statement-breakpoint
CREATE INDEX "op_runs_slug_started_idx" ON "op_runs" USING btree ("op_slug","started_at");--> statement-breakpoint
CREATE INDEX "op_runs_status_idx" ON "op_runs" USING btree ("status");