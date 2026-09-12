CREATE TABLE "sweatpals_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text,
	"membership_id" text,
	"membership_tier_id" text,
	"membership_name" text,
	"active" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"pause_future_payments" boolean DEFAULT false NOT NULL,
	"is_claimed" boolean DEFAULT false NOT NULL,
	"actual_from" timestamp with time zone,
	"actual_to" timestamp with time zone,
	"expire_date" timestamp with time zone,
	"cancellation_effective_at" timestamp with time zone,
	"sweatpals_email" text,
	"sweatpals_phone" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sweatpals_memberships_member_id_idx" ON "sweatpals_memberships" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "sweatpals_memberships_email_idx" ON "sweatpals_memberships" USING btree ("sweatpals_email");--> statement-breakpoint
CREATE INDEX "sweatpals_memberships_last_synced_idx" ON "sweatpals_memberships" USING btree ("last_synced_at");