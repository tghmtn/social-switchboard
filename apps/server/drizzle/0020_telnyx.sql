ALTER TABLE "workspaces" ADD COLUMN "telnyx" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "telnyx_key_enc" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "sms_provider" text;