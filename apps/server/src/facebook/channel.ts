import type { OutboundMessage } from '@social-switchboard/flow';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { contactIdentities, facebookPages, messages, type OutboundContent } from '../db/schema';
import { isPdfUrl, MetaError } from '../instagram/graph';
import { decryptOptional } from '../instagram/settings';
import { rememberSent } from '../instagram/takeover';
import type { ChannelAdapter, SendResult } from '../runtime/channels';
import { facebookFriendly, replyToPageComment, sendPageMessage } from './graph';

// Sending as a Facebook Page through Messenger. Like Instagram (whose messaging API follows
// Messenger's), with one difference: links in plain text are tappable on Messenger.

const DAY = 24 * 3_600_000;
const TEXT_LIMIT = 2000;
const BUTTON_TEXT_LIMIT = 640;

type FilePart = Extract<OutboundMessage['parts'][number], { type: 'file' }>;
type Button =
  | { type: 'web_url'; url: string; title: string }
  | { type: 'postback'; title: string; payload: string };

const fileText = (p: FilePart) => `📄 ${p.name}: ${p.url}`;
/** Messenger button titles stop at 20 characters. */
const fileTitle = (p: FilePart) => Array.from(`📄 ${p.name}`).slice(0, 20).join('');

/**
 * Turns one flow message into Messenger messages, in order. Buttons ride on the last text as a
 * button template, quick replies on the last message. A PDF Messenger can fetch (`pdfs`) goes as a
 * file; any other file link goes as a tappable line of text. A private reply to a comment must be
 * a single message, so there files become buttons (or lines of text once the buttons are full).
 */
export function toMessengerMessages(
  msg: OutboundMessage,
  payloads: Record<string, string>,
  single: boolean,
  pdfs: ReadonlySet<string> = new Set(),
): object[] {
  const buttons: Button[] = msg.buttons
    .slice(0, 3)
    .map((b) =>
      b.kind === 'url'
        ? { type: 'web_url', url: b.url, title: b.label }
        : { type: 'postback', title: b.label, payload: payloads[b.id] ?? b.id },
    );
  const asButton = (p: FilePart) => {
    if (buttons.some((b) => b.type === 'web_url' && b.url === p.url)) return true;
    if (buttons.length >= 3) return false;
    buttons.push({ type: 'web_url', url: p.url, title: fileTitle(p) });
    return true;
  };

  const items: ({ text: string } | { attachment: object })[] = [];
  if (single) {
    const texts = msg.parts.flatMap((p) =>
      p.type === 'text' ? [p.text] : p.type === 'file' && !asButton(p) ? [fileText(p)] : [],
    );
    if (texts.length > 0) items.push({ text: texts.join('\n\n') });
  } else {
    for (const p of msg.parts) {
      if (p.type === 'text') items.push({ text: p.text });
      else if (p.type === 'image')
        items.push({ attachment: { type: 'image', payload: { url: p.url, is_reusable: true } } });
      else if (pdfs.has(p.url))
        items.push({ attachment: { type: 'file', payload: { url: p.url, is_reusable: true } } });
      else items.push({ text: fileText(p) });
    }
  }

  let lastText = items.findLastIndex((m) => 'text' in m);
  if (buttons.length > 0 && lastText < 0) {
    items.push({ text: '👇' });
    lastText = items.length - 1;
  }
  const out: Record<string, unknown>[] = items.map((m, i) => {
    if (!('text' in m)) return m;
    if (i === lastText && buttons.length > 0)
      return {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: (m.text || '👇').slice(0, BUTTON_TEXT_LIMIT),
            buttons,
          },
        },
      };
    return { text: m.text.slice(0, TEXT_LIMIT) };
  });

  if (msg.quickReplies.length > 0) {
    if (out.length === 0) out.push({ text: '👇' });
    const target = out[out.length - 1] as Record<string, unknown>;
    target.quick_replies = msg.quickReplies
      .slice(0, 13)
      .map((q) => ({ content_type: 'text', title: q.label, payload: payloads[q.id] ?? q.id }));
  }
  return out;
}

/** The Page to send from: the one the contact talks to, else the workspace's first connected one. */
export async function pageFor(db: Db, workspaceId: string, accountRef: string | null) {
  if (accountRef) {
    const [page] = await db
      .select()
      .from(facebookPages)
      .where(and(eq(facebookPages.workspaceId, workspaceId), eq(facebookPages.pageId, accountRef)));
    if (page) return page;
  }
  const [first] = await db
    .select()
    .from(facebookPages)
    .where(and(eq(facebookPages.workspaceId, workspaceId), eq(facebookPages.status, 'connected')))
    .orderBy(asc(facebookPages.connectedAt))
    .limit(1);
  return first;
}

export function facebookChannel(db: Db, appSecret: string): ChannelAdapter {
  return {
    id: 'facebook',
    async send(target, content: OutboundContent): Promise<SendResult> {
      const page = await pageFor(db, target.workspaceId, target.accountRef);
      if (page?.status !== 'connected')
        return {
          status: 'failed',
          error: 'No Facebook Page is connected. Connect one on the Channels page.',
        };
      const token = decryptOptional(appSecret, page.accessTokenEnc);
      if (!token)
        return {
          status: 'failed',
          error:
            'The Facebook connection needs to be redone (its key changed). Reconnect on the Channels page.',
        };

      try {
        if (content.publicReplyTo) {
          const text = content.message.parts.find((p) => p.type === 'text');
          const res = await replyToPageComment(
            content.publicReplyTo,
            token,
            text?.type === 'text' ? text.text : '',
          );
          return { status: 'sent', externalId: res.id };
        }

        // Normal messages need the person to have messaged within the last 24 hours.
        if (!content.privateReplyTo) {
          const [last] = await db
            .select({ at: messages.createdAt })
            .from(messages)
            .where(
              and(
                eq(messages.contactId, target.contactId),
                eq(messages.channel, 'facebook'),
                eq(messages.direction, 'in'),
                sql`${messages.content} -> 'comment' is null`,
              ),
            )
            .orderBy(desc(messages.createdAt))
            .limit(1);
          if (!last || Date.now() - last.at.getTime() > DAY)
            return {
              status: 'blocked',
              error: last
                ? 'Outside Messenger’s 24-hour window: they haven’t messaged in over a day.'
                : 'They haven’t messaged yet, and Messenger only allows replies within 24 hours of their last message.',
            };
        }

        const recipient = content.privateReplyTo
          ? { comment_id: content.privateReplyTo }
          : { id: target.externalId };
        const single = Boolean(content.privateReplyTo);
        const pdfs = new Set<string>();
        if (!single)
          for (const p of content.message.parts)
            if (p.type === 'file' && (await isPdfUrl(p.url))) pdfs.add(p.url);
        let lastId: string | undefined;
        for (const message of toMessengerMessages(
          content.message,
          content.payloads,
          single,
          pdfs,
        )) {
          const res = await sendPageMessage(page.pageId, token, recipient, message);
          if (res.message_id) await rememberSent(db, target.workspaceId, res.message_id);
          // A comment's commenter and their Messenger self have different ids: link them, so
          // their reply in Messenger continues this contact's conversation.
          if (single && res.recipient_id)
            await db
              .insert(contactIdentities)
              .values({
                workspaceId: target.workspaceId,
                channel: 'facebook',
                externalId: res.recipient_id,
                contactId: target.contactId,
                accountRef: page.pageId,
              })
              .onConflictDoNothing();
          lastId = res.message_id ?? lastId;
        }
        return { status: 'sent', externalId: lastId };
      } catch (err) {
        if (err instanceof MetaError) {
          if (err.code === 190)
            await db
              .update(facebookPages)
              .set({ status: 'error', statusDetail: facebookFriendly(err), updatedAt: new Date() })
              .where(eq(facebookPages.id, page.id));
          return { status: 'failed', error: facebookFriendly(err) };
        }
        throw err;
      }
    },
  };
}
