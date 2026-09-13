CREATE TABLE "sweatpals_feed_cursors" (
	"feed" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"last_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
