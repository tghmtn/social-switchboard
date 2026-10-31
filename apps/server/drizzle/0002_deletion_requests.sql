CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"confirmation_code" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"contacts_deleted" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_requests_confirmation_code_unique" UNIQUE("confirmation_code")
);
