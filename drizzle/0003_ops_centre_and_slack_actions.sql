CREATE TABLE IF NOT EXISTS "slack_access_actions" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "slack_access_actions_idempotency_uidx" ON "slack_access_actions" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_access_actions_airtable_idx" ON "slack_access_actions" USING btree ("airtable_record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_access_actions_status_idx" ON "slack_access_actions" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "variant" text;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "parameters_json" text;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "progress_current" integer;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "progress_total" integer;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "error" text;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "operator_clerk_user_id" text;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "runtime_mode" text;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "checkpoint_json" text;
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "cancellation_requested" text DEFAULT '0';
--> statement-breakpoint
ALTER TABLE "op_runs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_runs_slug_started_idx" ON "op_runs" USING btree ("op_slug","started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_runs_status_idx" ON "op_runs" USING btree ("status");
