import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { contactIdentities, facebookPages } from '../db/schema';
import { decryptOptional } from '../instagram/settings';
import { personReplied, sentByUs } from '../instagram/takeover';
import { type RuntimeDeps, receive, receiveComment } from '../runtime/runtime';
import { messengerProfile } from './graph';

// Webhook events for connected Facebook Pages (object "page"): comments on the Page's posts
// (the "feed" field) and Messenger messages, taps and m.me link opens.

type PageEntry = {
  id?: string;
  changes?: {
    field?: string;
    value?: {
      item?: string;
      verb?: string;
      comment_id?: string;
      post_id?: string;
      parent_id?: string;
      message?: string;
      from?: { id?: string; name?: string };
    };
  }[];
  messaging?: {
    sender?: { id?: string };
    recipient?: { id?: string };
    message?: {
      mid?: string;
      text?: string;
      is_echo?: boolean;
      quick_reply?: { payload?: string };
    };
    postback?: { title?: string; payload?: string; referral?: { ref?: string } };
    referral?: { ref?: string };
  }[];
};
export type PagePayload = { object?: string; entry?: PageEntry[] };

/** "Ann Lee" as a first and last name. */
const splitName = (name?: string) => {
  const [first, ...rest] = (name ?? '').trim().split(/\s+/);
  return first ? { firstName: first, lastName: rest.join(' ') || undefined } : undefined;
};

export async function handlePage(
  deps: { db: Db; runtime: RuntimeDeps; appSecret: string },
  payload: PagePayload,
) {
  for (const entry of payload.entry ?? []) {
    if (!entry.id) continue;
    const [page] = await deps.db
      .select()
      .from(facebookPages)
      .where(eq(facebookPages.pageId, entry.id));
    if (!page) continue; // a Page this install doesn't (or no longer does) manage
    const token = decryptOptional(deps.appSecret, page.accessTokenEnc);
    const base = { workspaceId: page.workspaceId, channel: 'facebook', accountRef: entry.id };

    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== 'feed' || v?.item !== 'comment' || v.verb !== 'add') continue;
      if (!v.comment_id || !v.from?.id || v.from.id === entry.id) continue; // the Page's own
      await receiveComment(deps.runtime, {
        ...base,
        externalId: v.from.id,
        profile: splitName(v.from.name),
        commentId: v.comment_id,
        mediaId: v.post_id,
        text: v.message ?? '',
      });
    }

    for (const m of entry.messaging ?? []) {
      // The Page's own messages come back as echoes: ours, or a person replying in Facebook.
      if (m.message?.is_echo) {
        const to = m.recipient?.id;
        if (!to || (m.message.mid && (await sentByUs(deps.db, m.message.mid)))) continue;
        await personReplied(deps.db, {
          workspaceId: page.workspaceId,
          accountRef: entry.id,
          igsid: to,
          mid: m.message.mid,
          text: m.message.text,
          channel: 'facebook',
        });
        continue;
      }
      const sender = m.sender?.id;
      if (!sender || sender === entry.id) continue;
      const text = m.message?.text ?? m.postback?.title;
      const payloadValue = m.message?.quick_reply?.payload ?? m.postback?.payload;
      const ref = m.referral?.ref ?? m.postback?.referral?.ref;
      if (text === undefined && payloadValue === undefined && ref === undefined && !m.message)
        continue;
      // A new face: Messenger shares their name, so even the first reply can use it.
      const [known] = await deps.db
        .select({ contactId: contactIdentities.contactId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.workspaceId, page.workspaceId),
            eq(contactIdentities.channel, 'facebook'),
            eq(contactIdentities.externalId, sender),
          ),
        );
      const profile =
        !known && token ? await messengerProfile(sender, token).catch(() => undefined) : undefined;
      await receive(deps.runtime, {
        ...base,
        externalId: sender,
        profile: profile
          ? { firstName: profile.first_name, lastName: profile.last_name }
          : undefined,
        text,
        payload: payloadValue,
        ref,
      });
    }
  }
}
