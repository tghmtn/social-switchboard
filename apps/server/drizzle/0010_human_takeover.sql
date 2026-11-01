CREATE TABLE "sent_message_ids" (
	"external_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "automation_resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sent_message_ids" ADD CONSTRAINT "sent_message_ids_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sent_message_ids_created_idx" ON "sent_message_ids" USING btree ("created_at");