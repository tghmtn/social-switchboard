CREATE TABLE "facebook_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"name" text,
	"picture_url" text,
	"access_token_enc" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"status_detail" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facebook_pages_page_id_unique" UNIQUE("page_id")
);
--> statement-breakpoint
ALTER TABLE "meta_apps" ADD COLUMN "facebook_app_id" text;--> statement-breakpoint
ALTER TABLE "meta_apps" ADD COLUMN "facebook_config_id" text;--> statement-breakpoint
ALTER TABLE "meta_apps" ADD COLUMN "facebook_pending_enc" text;--> statement-breakpoint
ALTER TABLE "meta_apps" ADD COLUMN "facebook_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "facebook_pages" ADD CONSTRAINT "facebook_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facebook_pages_workspace_idx" ON "facebook_pages" USING btree ("workspace_id");