ALTER TABLE "meta_apps" ADD COLUMN "pending_token_enc" text;--> statement-breakpoint
ALTER TABLE "meta_apps" ADD COLUMN "pending_token_at" timestamp with time zone;