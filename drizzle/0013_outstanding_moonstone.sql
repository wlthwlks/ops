CREATE TABLE "introduction_banned_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"member_a_key" text NOT NULL,
	"member_b_key" text NOT NULL,
	"pair_key" text NOT NULL,
	"member_a_email" text,
	"member_b_email" text,
	"member_a_name" text,
	"member_b_name" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intro_banned_pairs_pair_key_uidx" ON "introduction_banned_pairs" USING btree ("pair_key");--> statement-breakpoint
CREATE INDEX "intro_banned_pairs_member_a_idx" ON "introduction_banned_pairs" USING btree ("member_a_key");--> statement-breakpoint
CREATE INDEX "intro_banned_pairs_member_b_idx" ON "introduction_banned_pairs" USING btree ("member_b_key");