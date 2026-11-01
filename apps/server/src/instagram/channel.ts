import type { OutboundMessage } from '@social-switchboard/flow';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { instagramAccounts, messages, type OutboundContent } from '../db/schema';
import type { ChannelAdapter, SendResult } from '../runtime/channels';
import { type Host, isPdfUrl, MESSAGES_OFF, MetaError, replyToComment, sendMessage } from './graph';
import { accountFor, decryptOptional } from './settings';
import { rememberSent } from './takeover';

const DAY = 24 * 3_600_000;
const TEXT_LIMIT = 1000;
const BUTTON_TEXT_LIMIT = 640;

type FilePart = Extract<OutboundMessage['parts'][number], { type: 'file' }>;
type Button =
  | { type: 'web_url'; url: string; title: string }
  | { type: 'postback'; title: string; payload: string };

const fileText = (p: FilePart) => `📄 ${p.name}: ${p.url}`;
/** Instagram button titles stop at 20 characters. */
const fileTitle = (p: FilePart) => Array.from(`📄 ${p.name}`).slice(0, 20).join('');

/**
 * Turns one flow message into Instagram API messages, in order. Buttons ride on the last text as
 * a button template, quick replies on the last message. Instagram never makes links tappable inside
 * a template, so a file goes as a document when it's a PDF Instagram can fetch (`pdfs`), otherwise
 * as a link button (skipped if a button already opens it), and only as plain text once the three
 * buttons are taken. A private reply to a comment must be a single message: there every file is a
 * button.
 */
export function toInstagramMessages(
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
  /** Adds a link button for the file; false when the buttons are full. */
  const asButton = (p: FilePart) => {
    if (buttons.some((b) => b.type === 'web_url' && b.url === p.url)) return true;
    if (buttons.length >= 3) return false;
    buttons.push({ type: 'web_url', url: p.url, title: fileTitle(p) });
    return true;
  };

  // Text items carry `text` (`link`: a file's link, kept out of the template so it stays tappable);
  // anything else is already an API message (an attachment).
  const items: ({ text: string; link?: boolean } | { attachment: object })[] = [];
  if (single) {
    const texts = msg.parts.flatMap((p) =>
      p.type === 'text' ? [p.text] : p.type === 'file' && !asButton(p) ? [fileText(p)] : [],
    );
    if (texts.length > 0) items.push({ text: texts.join('\n\n') });
  } else {
    for (const p of msg.parts) {
      if (p.type === 'text') items.push({ text: p.text });
      else if (p.type === 'image')
        items.push({ attachment: { type: 'image', payload: { url: p.url } } });
      else if (pdfs.has(p.url))
        items.push({ attachment: { type: 'file', payload: { url: p.url } } });
      else if (!asButton(p)) items.push({ text: fileText(p), link: true });
    }
  }

  let lastText = items.findLastIndex((m) => 'text' in m && !m.link);
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

export function instagramChannel(db: Db, appSecret: string): ChannelAdapter {
  return {
    id: 'instagram',
    async send(target, content: OutboundContent): Promise<SendResult> {
      const account = await accountFor(db, target.workspaceId, target.accountRef);
      if (account?.status !== 'connected')
        return {
          status: 'failed',
          error: 'No Instagram account is connected. Connect one on the Channels page.',
        };
      const token = decryptOptional(appSecret, account.accessTokenEnc);
      if (!token)
        return {
          status: 'failed',
          error:
            'The Instagram connection needs to be redone (its key changed). Reconnect on the Channels page.',
        };

      const host: Host = account.apiHost === 'facebook' ? 'facebook' : 'instagram';
      try {
        // A public reply under the comment.
        if (content.publicReplyTo) {
          const text = content.message.parts.find((p) => p.type === 'text');
          const res = await replyToComment(
            content.publicReplyTo,
            token,
            text?.type === 'text' ? text.text : '',
            host,
          );
          return { status: 'sent', externalId: res.id };
        }

        // Normal DMs need the person to have messaged within the last 24 hours.
        if (!content.privateReplyTo) {
          const [last] = await db
            .select({ at: messages.createdAt })
            .from(messages)
            .where(
              and(
                eq(messages.contactId, target.contactId),
                eq(messages.channel, 'instagram'),
                eq(messages.direction, 'in'),
                sql`${messages.content} -> 'comment' is null`,
              ),
            )
            .orderBy(desc(messages.createdAt))
            .limit(1);
          if (!last || Date.now() - last.at.getTime() > DAY) {
            return {
              status: 'blocked',
              error: last
                ? 'Outside Instagram’s 24-hour window: they haven’t messaged in over a day.'
                : 'They haven’t messaged yet, and Instagram only allows replies within 24 hours of their last message.',
            };
          }
        }

        const recipient = content.privateReplyTo
          ? { comment_id: content.privateReplyTo }
          : { id: target.externalId };
        const single = Boolean(content.privateReplyTo);
        // Which file links Instagram can attach as documents (a private reply shows files as buttons).
        const pdfs = new Set<string>();
        if (!single)
          for (const p of content.message.parts)
            if (p.type === 'file' && (await isPdfUrl(p.url))) pdfs.add(p.url);
        let lastId: string | undefined;
        for (const message of toInstagramMessages(
          content.message,
          content.payloads,
          single,
          pdfs,
        )) {
          const res = await sendMessage(account.igUserId, token, recipient, message, host);
          // Saved before anything else, so its echo is recognized as ours, not a person's.
          if (res.message_id) await rememberSent(db, target.workspaceId, res.message_id);
          lastId = res.message_id ?? lastId;
        }
        if (account.statusDetail === MESSAGES_OFF)
          await db
            .update(instagramAccounts)
            .set({ statusDetail: null, updatedAt: new Date() })
            .where(eq(instagramAccounts.id, account.id));
        return { status: 'sent', externalId: lastId };
      } catch (err) {
        if (err instanceof MetaError) {
          if (err.code === 190) {
            await db
              .update(instagramAccounts)
              .set({ status: 'error', statusDetail: err.friendly, updatedAt: new Date() })
              .where(eq(instagramAccounts.id, account.id));
          } else if (err.messagesOff) {
            // Still connected, but every DM will fail until the owner flips the switch: say so on Channels.
            await db
              .update(instagramAccounts)
              .set({ statusDetail: MESSAGES_OFF, updatedAt: new Date() })
              .where(eq(instagramAccounts.id, account.id));
          }
          return { status: 'failed', error: err.friendly };
        }
        throw err;
      }
    },
  };
}
