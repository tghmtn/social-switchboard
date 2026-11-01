ALTER TABLE "workspaces" ADD COLUMN "ai_provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_openai_model" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_openai_key_enc" text;