-- Alerts people sent to an ntfy topic now come as Switchboard's own notifications.
UPDATE "notification_prefs" SET "events" = (
  SELECT jsonb_object_agg(e.k, (
    SELECT coalesce(jsonb_agg(DISTINCT CASE WHEN c = 'push' THEN 'browser' ELSE c END), '[]'::jsonb)
    FROM jsonb_array_elements_text(e.v) AS c
  ))
  FROM jsonb_each("events") AS e(k, v)
) WHERE "events"::text LIKE '%"push"%';--> statement-breakpoint
ALTER TABLE "notification_prefs" DROP COLUMN "push_url";--> statement-breakpoint
ALTER TABLE "notification_prefs" DROP COLUMN "push_token_enc";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "notify_url";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "notify_token_enc";