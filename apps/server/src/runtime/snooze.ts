import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Notice } from '../notify';

/**
 * Snoozes whose time has come: tells whoever snoozed the conversation that it's back (its
 * assignee instead, if it has one). The conversation itself comes back on its own, by time; this
 * only sends the alert, once (snoozed_by is cleared as it goes).
 */
export async function wakeSnoozed(db: Db, notify?: (n: Notice) => void, now = new Date()) {
  const woken = await db.execute<{
    id: string;
    workspace_id: string;
    snoozed_by: string;
    assigned_user_id: string | null;
    conversation_status: 'open' | 'closed';
  }>(sql`update contacts c set snoozed_by = null
    from (select id, snoozed_by from contacts
      where snoozed_by is not null and snoozed_until <= ${now.toISOString()}::timestamptz
      for update skip locked) due
    where c.id = due.id
    returning c.id, c.workspace_id, due.snoozed_by, c.assigned_user_id, c.conversation_status`);
  for (const c of woken.rows)
    if (c.conversation_status === 'open')
      notify?.({
        workspaceId: c.workspace_id,
        contactId: c.id,
        channel: 'inbox',
        kind: 'snooze',
        userId: c.assigned_user_id ?? c.snoozed_by,
        text: 'Its snooze is over, so it’s back in the inbox.',
      });
  return woken.rows.length;
}
