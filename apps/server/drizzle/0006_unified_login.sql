ALTER TABLE "instagram_accounts" ADD COLUMN "api_host" text DEFAULT 'instagram' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_apps" ADD COLUMN "login_url" text;