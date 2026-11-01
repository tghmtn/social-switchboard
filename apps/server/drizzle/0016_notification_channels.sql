CREATE TABLE "notification_prefs" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"push_url" text,
	"push_token_enc" text,
	"email" text,
	"phone" text,
	"events" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "smtp" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "smtp_pass_enc" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "twilio" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "twilio_token_enc" text;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;