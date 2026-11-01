import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { instagramAccounts, webhookEvents } from '../db/schema';
import { handlePage, type PagePayload } from '../facebook/events';
import { type RuntimeDeps, receive, receiveComment } from '../runtime/runtime';
import { newContactProfile, saveAvatar, saveProfile, staleProfile } from './profiles';
import { decryptOptional } from './settings';
import { personReplied, sentByUs, tooSoonToTell } from './takeover';

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

/** The ids of the account's own messages echoed in a delivery. */
const echoIdsOf = (payload: Payload) =>
  (payload.entry ?? []).flatMap((e) =>
    (e.messaging ?? []).flatMap((m) =>
      m.message?.is_echo && m.message.mid ? [m.message.mid] : [],
    ),
  );

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
    // An echo of a message we may still be saving the id of: a later pass decides (the worker's).
    if (await tooSoonToTell(deps.db, ev.receivedAt, echoIdsOf(ev.payload as Payload))) continue;
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
  // Facebook Pages share this pipeline (same Meta app, webhooks and signatures).
  if (payload.object === 'page') return handlePage(deps, payload as PagePayload);
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
    const host = account.apiHost === 'facebook' ? 'facebook' : 'instagram';

    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== 'comments' || !v?.id || !v.from?.id) continue;
      if (v.from.id === entry.id) continue; // the account's own comments and replies
      await receiveComment(deps.runtime, {
        ...base,
        externalId: v.from.id,
        // A comment carries their username; Instagram shares more only once they've messaged.
        profile: v.from.username ? { username: v.from.username } : undefined,
        commentId: v.id,
        // A comment on a boosted post carries the ad's media id; triggers are set on the original post.
        mediaId: v.media?.original_media_id ?? v.media?.id,
        text: v.text ?? '',
      });
    }

    for (const m of entry.messaging ?? []) {
      // The account's own messages come back as echoes: ours, or a person replying in Instagram.
      if (m.message?.is_echo) {
        const to = m.recipient?.id;
        if (!to || (m.message.mid && (await sentByUs(deps.db, m.message.mid)))) continue;
        await personReplied(deps.db, {
          workspaceId: account.workspaceId,
          accountRef: entry.id,
          igsid: to,
          mid: m.message.mid,
          text: m.message.text,
        });
        continue;
      }
      const sender = m.sender?.id;
      if (!sender || sender === entry.id) continue;
      if (m.message?.is_deleted) continue;
      const text = m.message?.text ?? m.postback?.title;
      const payloadValue = m.message?.quick_reply?.payload ?? m.postback?.payload;
      const ref = m.referral?.ref;
      if (text === undefined && payloadValue === undefined && ref === undefined && !m.message)
        continue;
      // They've messaged us, so Instagram will share their profile (fetched at most weekly).
      // Names go in before the flow runs, so even the first reply can greet them by name.
      const profile = token
        ? await staleProfile(deps.db, account.workspaceId, sender, token, host)
        : undefined;
      const known = profile && (await saveProfile(deps.db, account.workspaceId, sender, profile));
      await receive(deps.runtime, {
        ...base,
        externalId: sender,
        profile: newContactProfile(profile),
        text,
        payload: payloadValue,
        ref,
      });
      if (profile) {
        if (!known) await saveProfile(deps.db, account.workspaceId, sender, profile);
        await saveAvatar(deps.db, account.workspaceId, sender, profile.profile_pic);
      }
    }
  }
}
