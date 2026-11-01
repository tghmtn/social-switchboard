import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { aiClient, aiErrorText, recordUsage, workspaceAi } from '../ai/client';
import type { RouteDeps } from '../app';
import type { Tx } from '../db/client';
import {
  contactEvents,
  contactIdentities,
  contacts,
  conversationReads,
  messages,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema';
import { lockContact, pauseForPerson, recordEvent } from '../runtime/contacts';
import { deliver } from '../runtime/runtime';
import { notFound, requireWorkspace, who } from './guard';

// The inbox: every conversation on the real channels (the simulator stays out), newest first,
// with read state per teammate, open/closed, an assignee, internal notes, and replies typed here.

const VIEWS = ['open', 'unread', 'mine', 'attention', 'closed', 'all'] as const;
type View = (typeof VIEWS)[number];
const DAY = 24 * 3_600_000;

/** Raw SQL hands timestamps back in Postgres's own format; the browser gets ISO 8601. */
const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

type Row = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  username: string | null;
  channel: string | null;
  avatar_version: string | null;
  conversation_status: 'open' | 'closed';
  assigned_user_id: string | null;
  automation_paused_at: string | null;
  automation_resume_at: string | null;
  last_seq: string;
  last_direction: 'in' | 'out';
  last_status: string;
  last_content: unknown;
  last_at: string;
  unread: number;
};

/** One line of text for a message, for the conversation list. */
function preview(content: unknown): string {
  const c = content as {
    kind?: string;
    text?: string;
    ref?: string;
    comment?: unknown;
    message?: { parts?: { type: string; text?: string; name?: string }[] };
    publicReplyTo?: string;
  };
  if (c.kind === 'in') {
    if (c.comment) return `Commented: ${c.text ?? ''}`;
    return c.text ?? (c.ref ? `Opened a link (${c.ref})` : '(a photo or attachment)');
  }
  const parts = c.message?.parts ?? [];
  const text = parts.find((p) => p.type === 'text')?.text;
  const shown =
    text ?? (parts[0]?.type === 'file' ? `📄 ${parts[0].name}` : parts[0] ? '(a photo)' : '');
  return c.publicReplyTo ? `Replied under the comment: ${shown}` : shown;
}

const SUGGEST_SYSTEM = `You draft replies to Instagram DMs for a small business or creator. Write the next message the business should send: plain text, usually one to three short sentences, warm and natural, in the same language and tone as the conversation. Answer what they last asked. Don't promise anything the conversation and notes don't support; where you'd need a detail you don't have (a price, a date, a link), put a placeholder in [square brackets] for the person to fill in. Skip greetings in the middle of a conversation. Reply with only the message.`;

export const inboxRoutes =
  ({ db, runtime, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    /** The latest real-channel message per contact, with unread counts for this teammate. */
    const conversations = (workspaceId: string, userId: string) => sql`
      select c.id, c.first_name, c.last_name, c.email, c.conversation_status, c.assigned_user_id,
        c.automation_paused_at, c.automation_resume_at,
        (select ci.username from contact_identities ci
          where ci.contact_id = c.id and ci.username is not null limit 1) as username,
        (select ci.channel from contact_identities ci
          where ci.contact_id = c.id and ci.channel <> 'simulator' limit 1) as channel,
        (select floor(extract(epoch from ca.updated_at))::bigint from contact_avatars ca
          where ca.contact_id = c.id) as avatar_version,
        lm.seq as last_seq, lm.direction as last_direction, lm.status as last_status,
        lm.content as last_content, lm.created_at as last_at,
        (select count(*)::int from messages m
          where m.contact_id = c.id and m.direction = 'in' and m.channel <> 'simulator'
            and m.seq > coalesce(r.last_read_seq, 0)) as unread
      from contacts c
      join lateral (
        select seq, direction, status, content, created_at from messages m
        where m.contact_id = c.id and m.channel <> 'simulator'
        order by m.created_at desc, m.seq desc limit 1
      ) lm on true
      left join conversation_reads r on r.contact_id = c.id and r.user_id = ${userId}
      where c.workspace_id = ${workspaceId}`;

    const viewFilter = (view: View, userId: string) => {
      switch (view) {
        case 'open':
          return sql`conversation_status = 'open'`;
        case 'unread':
          return sql`unread > 0`;
        case 'mine':
          return sql`assigned_user_id = ${userId} and conversation_status = 'open'`;
        case 'attention':
          return sql`automation_paused_at is not null`;
        case 'closed':
          return sql`conversation_status = 'closed'`;
        case 'all':
          return sql`true`;
      }
    };

    app.get('/inbox', async (req) => {
      const { user, workspace } = who(req);
      const q = z
        .object({
          view: z.enum(VIEWS).default('open'),
          q: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(60),
        })
        .parse(req.query);
      const base = conversations(workspace.id, user.id);
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : undefined;
      const search = like
        ? sql`(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
            coalesce(username, '') || ' ' || coalesce(email, '')) ilike ${like}`
        : sql`true`;
      const [rows, counts] = await Promise.all([
        db.execute<Row>(sql`select * from (${base}) conv
          where ${viewFilter(q.view, user.id)} and ${search}
          order by last_at desc limit ${q.limit}`),
        db.execute<Record<View, number>>(sql`select
            count(*) filter (where conversation_status = 'open')::int as open,
            count(*) filter (where unread > 0)::int as unread,
            count(*) filter (where assigned_user_id = ${user.id}
              and conversation_status = 'open')::int as mine,
            count(*) filter (where automation_paused_at is not null)::int as attention,
            count(*) filter (where conversation_status = 'closed')::int as closed,
            count(*)::int as all
          from (${base}) conv`),
      ]);
      return {
        conversations: rows.rows.map((r) => ({
          contactId: r.id,
          firstName: r.first_name,
          lastName: r.last_name,
          email: r.email,
          username: r.username,
          channel: r.channel,
          avatarVersion: r.avatar_version === null ? null : Number(r.avatar_version),
          status: r.conversation_status,
          assignedUserId: r.assigned_user_id,
          automationPausedAt: iso(r.automation_paused_at),
          automationResumeAt: iso(r.automation_resume_at),
          last: {
            direction: r.last_direction,
            status: r.last_status,
            text: preview(r.last_content).slice(0, 160),
            byPerson: Boolean((r.last_content as { byPerson?: boolean }).byPerson),
            at: iso(r.last_at),
          },
          unread: r.unread,
        })),
        counts: counts.rows[0],
      };
    });

    /** For the nav badge: open conversations with something unread. */
    app.get('/inbox/summary', async (req) => {
      const { user, workspace } = who(req);
      const result = await db.execute<{ n: number }>(sql`select count(*)::int as n
        from (${conversations(workspace.id, user.id)}) conv
        where unread > 0 and conversation_status = 'open'`);
      return { unread: result.rows[0]?.n ?? 0 };
    });

    const contactIn = async (workspaceId: string, id: string) => {
      const [c] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)));
      if (!c) throw notFound('Conversation');
      return c;
    };

    app.get('/inbox/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const c = await contactIn(workspace.id, id);
      const [identities, rows, notes, team, avatar] = await Promise.all([
        db
          .select({
            channel: contactIdentities.channel,
            username: contactIdentities.username,
            followsUs: contactIdentities.followsUs,
          })
          .from(contactIdentities)
          .where(
            and(eq(contactIdentities.contactId, id), ne(contactIdentities.channel, 'simulator')),
          ),
        db
          .select()
          .from(messages)
          .where(and(eq(messages.contactId, id), ne(messages.channel, 'simulator')))
          .orderBy(desc(messages.seq))
          .limit(200),
        db
          .select({ id: contactEvents.id, data: contactEvents.data, at: contactEvents.createdAt })
          .from(contactEvents)
          .where(and(eq(contactEvents.contactId, id), eq(contactEvents.type, 'note')))
          .orderBy(asc(contactEvents.createdAt))
          .limit(100),
        db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(eq(workspaceMembers.workspaceId, workspace.id)),
        db.execute<{
          v: string | null;
        }>(sql`select floor(extract(epoch from updated_at))::bigint as v
          from contact_avatars where contact_id = ${id}`),
      ]);
      const names = new Map(
        team.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email]),
      );
      const lastDm = rows.find(
        (m) => m.direction === 'in' && !(m.content as { comment?: unknown }).comment,
      );
      return {
        contact: {
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          avatarVersion: avatar.rows[0]?.v ? Number(avatar.rows[0].v) : null,
          status: c.conversationStatus,
          assignedUserId: c.assignedUserId,
          automationPausedAt: c.automationPausedAt,
          automationResumeAt: c.automationResumeAt,
        },
        identities,
        /** Instagram replies are only allowed within 24 hours of their last DM. */
        replyWindowEndsAt: lastDm ? new Date(lastDm.createdAt.getTime() + DAY) : null,
        messages: rows.reverse().map((m) => {
          const content = m.content as {
            kind: string;
            sentBy?: string;
            byPerson?: boolean;
            privateReplyTo?: string;
            publicReplyTo?: string;
          };
          return {
            id: m.id,
            seq: m.seq,
            direction: m.direction,
            status: m.status,
            error: m.error,
            at: m.createdAt,
            content: m.content,
            by:
              m.direction === 'in'
                ? 'them'
                : content.byPerson
                  ? (content.sentBy && names.get(content.sentBy)) || 'You (in Instagram)'
                  : 'Flow',
          };
        }),
        notes: notes.map((n) => ({
          id: n.id,
          text: String((n.data as { text?: string }).text ?? ''),
          by: names.get(String((n.data as { by?: string }).by)) ?? 'Someone',
          at: n.at,
        })),
        team: team.map((u) => ({ id: u.id, name: names.get(u.id) ?? u.email })),
      };
    });

    /** Marks everything up to now as read, for this teammate. */
    app.post('/inbox/:id/read', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await contactIn(workspace.id, id);
      const [last] = await db
        .select({ seq: sql<string>`max(${messages.seq})` })
        .from(messages)
        .where(eq(messages.contactId, id));
      const seq = Number(last?.seq ?? 0);
      await db
        .insert(conversationReads)
        .values({ userId: user.id, contactId: id, lastReadSeq: seq })
        .onConflictDoUpdate({
          target: [conversationReads.userId, conversationReads.contactId],
          set: {
            lastReadSeq: sql`greatest(${conversationReads.lastReadSeq}, ${seq})`,
            updatedAt: new Date(),
          },
        });
      return { ok: true };
    });

    /**
     * A reply typed here. It goes out like a flow's message (same channel rules: Instagram's
     * 24-hour window), and once sent pauses automation like a reply from the Instagram app.
     */
    app.post('/inbox/:id/reply', async (req, reply) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);
      await contactIn(workspace.id, id);
      const [identity] = await db
        .select({ channel: contactIdentities.channel })
        .from(contactIdentities)
        .where(and(eq(contactIdentities.contactId, id), ne(contactIdentities.channel, 'simulator')))
        .limit(1);
      if (!identity) return reply.code(409).send({ error: 'no_channel' });
      const [queued] = await db
        .insert(messages)
        .values({
          workspaceId: workspace.id,
          contactId: id,
          channel: identity.channel,
          direction: 'out',
          status: 'queued',
          content: {
            kind: 'out',
            message: { parts: [{ type: 'text', text }], buttons: [], quickReplies: [] },
            payloads: {},
            byPerson: true,
            sentBy: user.id,
          },
        })
        .returning({ id: messages.id });
      if (!queued) throw new Error('message insert returned no row');
      await deliver(runtime, [queued.id]);
      const [sent] = await db.select().from(messages).where(eq(messages.id, queued.id));
      if (sent?.status === 'sent')
        await db.transaction(async (tx) => {
          await lockContact(tx, id);
          const until = await pauseForPerson(tx, id, new Date());
          await recordEvent(tx, workspace.id, id, 'person_replied', {
            by: user.id,
            via: 'inbox',
            pausedUntil: until?.toISOString() ?? null,
          });
        });
      return { message: { id: sent?.id, status: sent?.status, error: sent?.error } };
    });

    const update = (workspaceId: string, id: string, fn: (tx: Tx) => Promise<void>) =>
      db.transaction(async (tx) => {
        await lockContact(tx, id);
        const [c] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)));
        if (!c) throw notFound('Conversation');
        await fn(tx);
      });

    app.post('/inbox/:id/status', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { status } = z.object({ status: z.enum(['open', 'closed']) }).parse(req.body);
      await update(workspace.id, id, async (tx) => {
        await tx
          .update(contacts)
          .set({ conversationStatus: status, updatedAt: new Date() })
          .where(eq(contacts.id, id));
        await recordEvent(tx, workspace.id, id, `conversation_${status}`, { by: user.id });
      });
      return { ok: true };
    });

    app.post('/inbox/:id/assign', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { userId } = z.object({ userId: z.uuid().nullable() }).parse(req.body);
      if (userId) {
        const [member] = await db
          .select({ id: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspace.id),
              inArray(workspaceMembers.userId, [userId]),
            ),
          );
        if (!member) throw notFound('Teammate');
      }
      await update(workspace.id, id, async (tx) => {
        await tx
          .update(contacts)
          .set({ assignedUserId: userId, updatedAt: new Date() })
          .where(eq(contacts.id, id));
        await recordEvent(tx, workspace.id, id, 'conversation_assigned', {
          by: user.id,
          to: userId,
        });
      });
      return { ok: true };
    });

    /**
     * Drafts the next reply with the workspace's AI, from the conversation and the team's notes.
     * Only a draft: it fills the reply box, and a person edits and sends it.
     */
    app.post('/inbox/:id/suggest', async (req, reply) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const c = await contactIn(workspace.id, id);
      const ai = await workspaceAi(db, config.appSecret, workspace.id);
      if (!ai)
        return reply.code(409).send({ error: 'Add an Anthropic API key in Settings → AI first.' });
      const [ws] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      const [rows, notes] = await Promise.all([
        db
          .select()
          .from(messages)
          .where(and(eq(messages.contactId, id), ne(messages.channel, 'simulator')))
          .orderBy(desc(messages.seq))
          .limit(30),
        db
          .select({ data: contactEvents.data })
          .from(contactEvents)
          .where(and(eq(contactEvents.contactId, id), eq(contactEvents.type, 'note')))
          .orderBy(desc(contactEvents.createdAt))
          .limit(10),
      ]);
      if (rows.length === 0)
        return reply.code(409).send({ error: 'There’s nothing to reply to yet.' });
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'them';
      const transcript = rows
        .reverse()
        .map((m) => {
          const who =
            m.direction === 'in'
              ? name
              : (m.content as { byPerson?: boolean }).byPerson
                ? 'Us'
                : 'Us (automated)';
          return `${who}: ${preview(m.content)}${m.status === 'failed' || m.status === 'blocked' ? ' [not delivered]' : ''}`;
        })
        .join('\n');
      const noteText = notes
        .map((n) => `- ${String((n.data as { text?: string }).text ?? '')}`)
        .join('\n');
      try {
        const response = await aiClient(ai.apiKey).beta.messages.create(
          {
            model: ai.model.id,
            max_tokens: 4000,
            system: SUGGEST_SYSTEM,
            output_config: { effort: 'low' },
            ...(ai.model.fallbacks
              ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
              : {}),
            messages: [
              {
                role: 'user',
                content: `The business: ${ws?.name ?? 'this account'}.\n${noteText ? `Team notes about this person:\n${noteText}\n` : ''}\nThe conversation so far, oldest first:\n${transcript}\n\nDraft our next message to ${name}.`,
              },
            ],
          },
          // Someone is waiting on the button, behind a proxy that gives up at 100 seconds.
          { timeout: 40_000, maxRetries: 1 },
        );
        await recordUsage(db, { workspaceId: workspace.id, userId: user.id }, response);
        const text = response.content
          .flatMap((b) => (b.type === 'text' ? [b.text] : []))
          .join('')
          .trim();
        if (response.stop_reason === 'refusal' || !text)
          return reply.code(502).send({ error: 'The AI didn’t suggest anything this time.' });
        return { text };
      } catch (err) {
        return reply.code(502).send({ error: aiErrorText(err) });
      }
    });

    /** An internal note on the conversation: teammates see it, the contact never does. */
    app.post('/inbox/:id/note', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
      await update(workspace.id, id, (tx) =>
        recordEvent(tx, workspace.id, id, 'note', { text, by: user.id }),
      );
      return { ok: true };
    });
  };
