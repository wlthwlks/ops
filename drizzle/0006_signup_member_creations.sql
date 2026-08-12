CREATE TABLE IF NOT EXISTS "signup_member_creations" (
	"memberstack_id" text PRIMARY KEY NOT NULL,
	"email_normalized" text NOT NULL,
	"status" text DEFAULT 'CREATING' NOT NULL,
	"created_by" text NOT NULL,
	"airtable_record_id" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_member_creations_email_idx" ON "signup_member_creations" USING btree ("email_normalized");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_member_creations_status_idx" ON "signup_member_creations" USING btree ("status");