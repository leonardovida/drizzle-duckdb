CREATE SEQUENCE IF NOT EXISTS serial_users12;

CREATE TABLE IF NOT EXISTS "buplic"."users12" (
	"id" integer PRIMARY KEY NOT NULL DEFAULT nextval('serial_users12'),
	"name" text NOT NULL,
	"email" text NOT NULL
);
