import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import {
  contactIdentities,
  messages,
  type OutboundContent,
  type WebchatSettings,
  workspaces,
} from '../db/schema';
import { receive } from '../runtime/runtime';
import { notFound, requireAdmin, requireWorkspace, who } from './guard';

// Web chat: a chat window on the workspace's own website (a blog, a shop), running the same flows
// as Instagram and Facebook. The site loads /webchat.js, which opens /webchat.html in a frame on
// this server; that page talks to the public routes below with the widget's public key and a
// visitor token it keeps in the browser. Only the token's hash is stored, as the visitor's id on
// this channel, so a copy of the database can't be used to read anyone's chat.

export const WEBCHAT = 'webchat';
const DEFAULTS = { title: 'Chat with us', greeting: 'Hi! How can we help?', color: '#5b2ef0' };
const visitorId = (token: string) => createHash('sha256').update(token).digest('base64url');

const keyParam = z.object({ key: z.string().regex(/^wc_[A-Za-z0-9_-]{8,64}$/) });
const token = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const after = z.number().int().min(0).default(0);

/** What the visitor's chat window may show of a message: no internal payloads or teammate ids. */
function visible(content: unknown, direction: 'in' | 'out') {
  if (direction === 'in') return { text: (content as { text?: string }).text ?? '' };
  const { message } = content as OutboundContent;
  return {
    parts: message.parts,
    buttons: message.buttons.map((b) =>
      b.kind === 'url'
        ? { id: b.id, kind: b.kind, label: b.label, url: b.url }
        : { id: b.id, kind: b.kind, label: b.label },
    ),
    quickReplies: message.quickReplies.map((q) => ({ id: q.id, label: q.label })),
  };
}

/** Settings → Channels → Web chat, for the team. */
export const webchatRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    const load = async (workspaceId: string) => {
      const [ws] = await db
        .select({ webchat: workspaces.webchat })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return ws?.webchat ?? null;
    };

    app.get('/webchat/settings', async (req) => {
      const { workspace } = who(req);
      const saved = await load(workspace.id);
      return {
        settings: saved ?? { enabled: false, key: null, ...DEFAULTS },
        /** Where the embed code loads the chat from. */
        origin: config.publicUrl,
      };
    });

    app.put('/webchat/settings', async (req) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          enabled: z.boolean(),
          title: z.string().trim().min(1, 'Give the chat a title.').max(40),
          greeting: z.string().trim().max(300),
          color: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a color like #5b2ef0.'),
        })
        .parse(req.body);
      const saved = await load(workspace.id);
      // The key stays the same once made, so the embed code on the site keeps working.
      const settings: WebchatSettings = {
        ...body,
        key: saved?.key ?? `wc_${randomBytes(12).toString('base64url')}`,
      };
      await db.update(workspaces).set({ webchat: settings }).where(eq(workspaces.id, workspace.id));
      return { settings, origin: config.publicUrl };
    });
  };

/** What the chat window on someone's website talks to. No sign-in: the widget key and a token. */
export const webchatPublicRoutes =
  ({ db, runtime }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    const widget = async (key: string) => {
      const [ws] = await db
        .select({ id: workspaces.id, webchat: workspaces.webchat })
        .from(workspaces)
        .where(sql`${workspaces.webchat}->>'key' = ${key}`);
      if (!ws?.webchat?.enabled) throw notFound('Chat');
      return { workspaceId: ws.id, settings: ws.webchat };
    };

    const contactOf = async (workspaceId: string, visitor: string) => {
      const [row] = await db
        .select({ contactId: contactIdentities.contactId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.workspaceId, workspaceId),
            eq(contactIdentities.channel, WEBCHAT),
            eq(contactIdentities.externalId, visitorId(visitor)),
          ),
        );
      return row?.contactId;
    };

    /** The visitor's conversation after `from` (a message seq): what they sent and what we did. */
    const transcript = async (workspaceId: string, visitor: string, from: number) => {
      const contactId = await contactOf(workspaceId, visitor);
      if (!contactId) return [];
      const rows = await db
        .select({
          seq: messages.seq,
          direction: messages.direction,
          status: messages.status,
          content: messages.content,
          at: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.contactId, contactId),
            eq(messages.channel, WEBCHAT),
            gt(messages.seq, from),
          ),
        )
        .orderBy(asc(messages.seq))
        .limit(200);
      return rows
        .filter((m) => m.direction === 'in' || m.status === 'sent')
        .map((m) => ({
          seq: m.seq,
          from: m.direction === 'in' ? ('visitor' as const) : ('us' as const),
          ...visible(m.content, m.direction),
          at: m.at,
        }));
    };

    /** The look, for the launcher button the site's page draws (so any site may read it). */
    app.get(
      '/webchat/:key',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const { key } = keyParam.parse(req.params);
        reply.header('access-control-allow-origin', '*');
        const { settings } = await widget(key);
        return { title: settings.title, greeting: settings.greeting, color: settings.color };
      },
    );

    app.post(
      '/webchat/:key/poll',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req) => {
        const { key } = keyParam.parse(req.params);
        const body = z.object({ token, after }).parse(req.body);
        const { workspaceId } = await widget(key);
        return { messages: await transcript(workspaceId, body.token, body.after) };
      },
    );

    /** Something the visitor typed, or a quick reply or button they tapped (by message and id). */
    app.post(
      '/webchat/:key/send',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const { key } = keyParam.parse(req.params);
        const body = z
          .object({
            token,
            after,
            text: z.string().trim().min(1).max(2000).optional(),
            choice: z
              .object({ seq: z.number().int().positive(), id: z.string().max(64) })
              .optional(),
          })
          .refine((b) => b.text || b.choice, { message: 'Type a message.' })
          .parse(req.body);
        const { workspaceId } = await widget(key);

        let input: { text?: string; payload?: string } = { text: body.text };
        if (body.choice) {
          const contactId = await contactOf(workspaceId, body.token);
          const [sent] = contactId
            ? await db
                .select({ content: messages.content })
                .from(messages)
                .where(
                  and(
                    eq(messages.contactId, contactId),
                    eq(messages.seq, body.choice.seq),
                    eq(messages.direction, 'out'),
                  ),
                )
            : [];
          const content = sent?.content as OutboundContent | undefined;
          const payload = content?.payloads[body.choice.id];
          const label = [
            ...(content?.message.buttons ?? []),
            ...(content?.message.quickReplies ?? []),
          ].find((b) => b.id === body.choice?.id)?.label;
          if (!payload || !label)
            return reply.code(409).send({ error: 'That choice isn’t available anymore.' });
          input = { payload, text: label };
        }

        await receive(runtime, {
          workspaceId,
          channel: WEBCHAT,
          externalId: visitorId(body.token),
          profile: {},
          ...input,
        });
        return { messages: await transcript(workspaceId, body.token, body.after) };
      },
    );
  };
