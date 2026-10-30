CREATE TABLE "accounts" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" integer PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"feature" text NOT NULL,
	"units" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
