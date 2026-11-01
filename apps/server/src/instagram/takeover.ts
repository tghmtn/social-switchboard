import { and, eq, inArray, isNotNull, lt, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { contacts, messages, runs, sentMessageIds } from '../db/schema';
import { findOrCreateContact, lockContact, recordEvent } from '../runtime/contacts';

// Human takeover. Instagram echoes every message the account sends, ours and ones typed in the
// Instagram app alike, without saying which app sent it. We remember the id of each message we
// send; an echo we don't recognize is a person replying, and pauses automation for that contact.

/** How long a person's reply keeps automation off for that contact; each new reply restarts it. */
export const TAKEOVER_PAUSE = 12 * 3_600_000;

/**
 * An echo can arrive before we've saved the id of the message it echoes, so an unknown echo
 * waits this long before it counts as a person. Swappable for tests.
 */
let echoGraceMs = 30_000;
export function setEchoGraceMs(ms: number) {
  echoGraceMs = ms;
}

/** Called right after Instagram accepts a message from us. */
export async function rememberSent(db: Db, workspaceId: string, externalId: string) {
  await db.insert(sentMessageIds).values({ workspaceId, externalId }).onConflictDoNothing();
}

export async function sentByUs(db: Db, externalId: string) {
  const [row] = await db
    .select({ id: sentMessageIds.externalId })
    .from(sentMessageIds)
    .where(eq(sentMessageIds.externalId, externalId));
  return Boolean(row);
}

/** True while an echo we don't recognize might still be ours, its id not saved yet. */
export async function tooSoonToTell(db: Db, receivedAt: Date, echoIds: string[]) {
  if (echoIds.length === 0 || Date.now() - receivedAt.getTime() >= echoGraceMs) return false;
  const known = await db
    .select({ id: sentMessageIds.externalId })
    .from(sentMessageIds)
    .where(inArray(sentMessageIds.externalId, echoIds));
  return known.length < new Set(echoIds).size;
}

/**
 * A person replied from the Instagram app: keep their message, cancel any flow waiting on this
 * contact, and pause automation for TAKEOVER_PAUSE. A hand-off pause stays as it is (no end).
 */
export async function personReplied(
  db: Db,
  input: { workspaceId: string; accountRef: string; igsid: string; mid?: string; text?: string },
) {
  await db.transaction(async (tx) => {
    const { contactId } = await findOrCreateContact(
      tx,
      input.workspaceId,
      'instagram',
      input.igsid,
      {
        accountRef: input.accountRef,
      },
    );
    await lockContact(tx, contactId);
    const now = new Date();
    const [contact] = await tx
      .select({ pausedAt: contacts.automationPausedAt, resumeAt: contacts.automationResumeAt })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    const handedOff = Boolean(contact?.pausedAt && !contact.resumeAt);
    const until = new Date(now.getTime() + TAKEOVER_PAUSE);
    if (!handedOff)
      await tx
        .update(contacts)
        .set({
          automationPausedAt: contact?.pausedAt ?? now,
          automationResumeAt: until,
          updatedAt: now,
        })
        .where(eq(contacts.id, contactId));
    // A question the flow was waiting on would otherwise catch their next message.
    await tx
      .update(runs)
      .set({ status: 'cancelled', endedAt: now, updatedAt: now, wakeAt: null })
      .where(and(eq(runs.contactId, contactId), eq(runs.status, 'waiting')));
    await tx.insert(messages).values({
      workspaceId: input.workspaceId,
      contactId,
      channel: 'instagram',
      direction: 'out',
      status: 'sent',
      sentAt: now,
      externalId: input.mid,
      content: {
        kind: 'out',
        message: {
          parts: [{ type: 'text', text: input.text ?? '(a photo or attachment)' }],
          buttons: [],
          quickReplies: [],
        },
        payloads: {},
        byPerson: true,
      },
    });
    await recordEvent(tx, input.workspaceId, contactId, 'person_replied', {
      pausedUntil: handedOff ? null : until.toISOString(),
    });
  });
}

/** Ends person-replied pauses whose time is up. Run by the worker. */
export async function resumeDue(db: Db, now = new Date()) {
  const resumed = await db
    .update(contacts)
    .set({ automationPausedAt: null, automationResumeAt: null, updatedAt: now })
    .where(and(isNotNull(contacts.automationResumeAt), lte(contacts.automationResumeAt, now)))
    .returning({ id: contacts.id, workspaceId: contacts.workspaceId });
  for (const c of resumed)
    await db.transaction((tx) =>
      recordEvent(tx, c.workspaceId, c.id, 'automation_resumed', { automatic: true }),
    );
  return resumed.length;
}

/** Sent ids only matter for the minute their echo takes; keep two days. */
export async function forgetSentIds(db: Db, now = new Date()) {
  await db
    .delete(sentMessageIds)
    .where(lt(sentMessageIds.createdAt, new Date(now.getTime() - 2 * 24 * 3_600_000)));
}
