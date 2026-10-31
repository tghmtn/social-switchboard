ALTER TABLE "users" ADD COLUMN "first_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "users" SET "first_name" = split_part(trim("name"), ' ', 1), "last_name" = trim(substr(trim("name"), length(split_part(trim("name"), ' ', 1)) + 1));
