CREATE TABLE "contact_avatars" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "follows_us" boolean;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "we_follow" boolean;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "follower_count" integer;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "verified" boolean;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "profile_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_avatars" ADD CONSTRAINT "contact_avatars_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_avatars" ADD CONSTRAINT "contact_avatars_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;