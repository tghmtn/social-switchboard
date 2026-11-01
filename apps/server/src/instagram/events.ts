import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { contactIdentities, instagramAccounts, webhookEvents } from '../db/schema';
import { type RuntimeDeps, receive, receiveComment } from '../runtime/runtime';
import { lookupUsername } from './graph';
import { decryptOptional } from './settings';

// Turns stored Instagram webhook deliveries into runtime calls. Payload shapes follow Meta's
// Instagram webhooks; parsing rules adapted from OpenReply (MIT), lib/meta/webhook.ts.

type Entry = {
  id?: string;
  changes?: {
    field?: string;
    value?: {
      id?: string;
      text?: string;
      from?: { id?: string; username?: string };
      media?: { id?: string; original_media_id?: string };
    };
  }[];
  messaging?: {
    sender?: { id?: string };
    recipient?: { id?: string };
    message?: {
      mid?: string;
      text?: string;
      is_echo?: boolean;
      is_deleted?: boolean;
      quick_reply?: { payload?: string };
    };
    postback?: { title?: string; payload?: string };
    referral?: { ref?: string };
  }[];
};
type Payload = { object?: string; entry?: Entry[] };

const MAX_ATTEMPTS = 5;
/** A claim older than this is treated as a crashed pass and taken over. */
const CLAIM_TIMEOUT = 2 * 60_000;

/** Processes stored deliveries oldest first. Safe to call from several places at once. */
export async function processWebhookEvents(
  deps: { db: Db; runtime: RuntimeDeps; appSecret: string },
  limit = 20,
) {
  // Every delivery (Instagram's echo of our own reply, too) starts a pass, so passes overlap: an
  // event another pass is still handling is off limits, unless its claim looks stuck (a crash).
  const free = () =>
    or(
      isNull(webhookEvents.claimedAt),
      lt(webhookEvents.claimedAt, new Date(Date.now() - CLAIM_TIMEOUT)),
    );
  const pending = await deps.db
    .select()
    .from(webhookEvents)
    .where(and(isNull(webhookEvents.processedAt), lt(webhookEvents.attempts, MAX_ATTEMPTS), free()))
    .orderBy(asc(webhookEvents.id))
    .limit(limit);
  for (const ev of pending) {
    const [claimed] = await deps.db
      .update(webhookEvents)
      .set({ attempts: sql`${webhookEvents.attempts} + 1`, claimedAt: new Date() })
      .where(and(eq(webhookEvents.id, ev.id), isNull(webhookEvents.processedAt), free()))
      .returning({ id: webhookEvents.id });
    if (!claimed) continue;
    try {
      await handle(deps, ev.payload as Payload);
      await deps.db
        .update(webhookEvents)
        .set({ processedAt: new Date(), error: null })
        .where(eq(webhookEvents.id, ev.id));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.runtime.log?.('instagram webhook processing failed', { eventId: ev.id, error });
      // Released, so the next pass retries it.
      await deps.db
        .update(webhookEvents)
        .set({ error, claimedAt: null })
        .where(eq(webhookEvents.id, ev.id));
    }
  }
  return pending.length;
}

async function handle(deps: { db: Db; runtime: RuntimeDeps; appSecret: string }, payload: Payload) {
  if (payload.object !== 'instagram') return;
  for (const entry of payload.entry ?? []) {
    if (!entry.id) continue;
    const [account] = await deps.db
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.igUserId, entry.id));
    if (!account) continue; // an account this install doesn't (or no longer does) manage
    const token = decryptOptional(deps.appSecret, account.accessTokenEnc);
    const base = { workspaceId: account.workspaceId, channel: 'instagram', accountRef: entry.id };

    // Ask Instagram for a username the first time we meet someone, so contacts aren't just numbers.
    const profileFor = async (igsid: string, known?: string) => {
      if (known) return { username: known };
      const [existing] = await deps.db
        .select({ id: contactIdentities.contactId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.workspaceId, account.workspaceId),
            eq(contactIdentities.channel, 'instagram'),
            eq(contactIdentities.externalId, igsid),
          ),
        );
      if (existing || !token) return undefined;
      const username = await lookupUsername(
        token,
        igsid,
        account.apiHost === 'facebook' ? 'facebook' : 'instagram',
      );
      return username ? { username } : undefined;
    };

    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== 'comments' || !v?.id || !v.from?.id) continue;
      if (v.from.id === entry.id) continue; // the account's own comments and replies
      await receiveComment(deps.runtime, {
        ...base,
        externalId: v.from.id,
        profile: await profileFor(v.from.id, v.from.username),
        commentId: v.id,
        // A comment on a boosted post carries the ad's media id; triggers are set on the original post.
        mediaId: v.media?.original_media_id ?? v.media?.id,
        text: v.text ?? '',
      });
    }

    for (const m of entry.messaging ?? []) {
      const sender = m.sender?.id;
      if (!sender || sender === entry.id) continue; // our own messages echoing back
      if (m.message?.is_echo || m.message?.is_deleted) continue;
      const text = m.message?.text ?? m.postback?.title;
      const payloadValue = m.message?.quick_reply?.payload ?? m.postback?.payload;
      const ref = m.referral?.ref;
      if (text === undefined && payloadValue === undefined && ref === undefined && !m.message)
        continue;
      await receive(deps.runtime, {
        ...base,
        externalId: sender,
        profile: await profileFor(sender),
        text,
        payload: payloadValue,
        ref,
      });
    }
  }
}
