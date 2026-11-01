import type { OutboundMessage } from '@social-switchboard/flow';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { instagramAccounts, messages, type OutboundContent } from '../db/schema';
import type { ChannelAdapter, SendResult } from '../runtime/channels';
import { type Host, MESSAGES_OFF, MetaError, replyToComment, sendMessage } from './graph';
import { accountFor, decryptOptional } from './settings';

const DAY = 24 * 3_600_000;
const TEXT_LIMIT = 1000;
const BUTTON_TEXT_LIMIT = 640;

/**
 * Turns one flow message into Instagram API messages. Everything goes out in order; buttons ride
 * on the last text as a button template, quick replies on the last message. A private reply to a
 * comment must be a single message, so it's collapsed into one.
 */
export function toInstagramMessages(
  msg: OutboundMessage,
  payloads: Record<string, string>,
  single: boolean,
): object[] {
  const texts = msg.parts.flatMap((p) =>
    p.type === 'text' ? [p.text] : p.type === 'file' ? [`📄 ${p.name}: ${p.url}`] : [],
  );
  const out: object[] = [];
  let finalText: string | undefined;

  if (single) {
    finalText = texts.join('\n\n');
  } else {
    const lastTextIndex = msg.parts.findLastIndex((p) => p.type === 'text' || p.type === 'file');
    msg.parts.forEach((p, i) => {
      if (i === lastTextIndex) return;
      if (p.type === 'image') out.push({ attachment: { type: 'image', payload: { url: p.url } } });
      else
        out.push({
          text: (p.type === 'text' ? p.text : `📄 ${p.name}: ${p.url}`).slice(0, TEXT_LIMIT),
        });
    });
    const last = msg.parts[lastTextIndex];
    finalText = last
      ? last.type === 'text'
        ? last.text
        : last.type === 'file'
          ? `📄 ${last.name}: ${last.url}`
          : undefined
      : undefined;
  }

  let final: Record<string, unknown> | undefined;
  if (msg.buttons.length > 0) {
    final = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: (finalText || '👇').slice(0, BUTTON_TEXT_LIMIT),
          buttons: msg.buttons
            .slice(0, 3)
            .map((b) =>
              b.kind === 'url'
                ? { type: 'web_url', url: b.url, title: b.label }
                : { type: 'postback', title: b.label, payload: payloads[b.id] ?? b.id },
            ),
        },
      },
    };
  } else if (finalText) {
    final = { text: finalText.slice(0, TEXT_LIMIT) };
  }
  if (final) out.push(final);

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
        let lastId: string | undefined;
        for (const message of toInstagramMessages(
          content.message,
          content.payloads,
          Boolean(content.privateReplyTo),
        )) {
          const res = await sendMessage(account.igUserId, token, recipient, message, host);
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
