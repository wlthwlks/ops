CREATE TABLE IF NOT EXISTS "webhook_events" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_provider_event_uidx" ON "webhook_events" USING btree ("provider","provider_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_status_idx" ON "webhook_events" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_type_idx" ON "webhook_events" USING btree ("event_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_errors" (
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
CREATE INDEX IF NOT EXISTS "integration_errors_status_idx" ON "integration_errors" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_errors_code_idx" ON "integration_errors" USING btree ("public_error_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_errors_source_idx" ON "integration_errors" USING btree ("source");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_analytics_events" (
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
CREATE INDEX IF NOT EXISTS "form_analytics_events_type_idx" ON "form_analytics_events" USING btree ("event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_analytics_events_created_idx" ON "form_analytics_events" USING btree ("created_at");
