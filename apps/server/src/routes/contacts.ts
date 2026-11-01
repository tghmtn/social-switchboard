import { fieldKey, SYSTEM_FIELDS, tagName } from '@social-switchboard/flow';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { csvRow } from '../csv';
import type { Tx } from '../db/client';
import {
  consents,
  contactAvatars,
  contactEvents,
  contactIdentities,
  contacts,
  fieldDefinitions,
  flows,
  runs,
} from '../db/schema';
import {
  addTag,
  loadSnapshot,
  lockContact,
  recordEvent,
  removeTag,
  saveFields,
} from '../runtime/contacts';
import { notFound, requireWorkspace, who } from './guard';

// Drizzle renders a column inside a select-list sql`` as a bare "id" when the query has one
// table, which a subquery would resolve to its own id column. Name the outer row explicitly.
const CONTACT_ID = sql.raw('"contacts"."id"');
const tagsOf = sql<string[]>`coalesce((
  select array_agg(t.name order by lower(t.name)) from contact_tags ct join tags t on t.id = ct.tag_id
  where ct.contact_id = ${CONTACT_ID}), '{}')`;
const channelsOf = sql<string[]>`coalesce((
  select array_agg(distinct ci.channel) from contact_identities ci where ci.contact_id = ${CONTACT_ID}), '{}')`;
const usernameOf = sql<string | null>`(
  select ci.username from contact_identities ci where ci.contact_id = ${CONTACT_ID} and ci.username is not null limit 1)`;
/** Changes when the picture does, so the browser can cache /contacts/:id/avatar?v= for good. */
const avatarVersionOf = sql<number | null>`(
  select floor(extract(epoch from ca.updated_at))::bigint from contact_avatars ca where ca.contact_id = ${CONTACT_ID})`.mapWith(
  (v) => (v === null ? null : Number(v)),
);

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const optionalText = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .transform((s) => (s ? s : null));
const patchBody = z.object({
  firstName: optionalText.optional(),
  lastName: optionalText.optional(),
  email: z
    .union([z.email().max(254), z.literal(''), z.null()])
    .transform((s) => (s ? s.toLowerCase() : null))
    .optional(),
  phone: optionalText.optional(),
  fields: z
    .record(fieldKey, z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export const contactRoutes =
  ({ db }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    const filters = (workspaceId: string, q?: string, tag?: string) => {
      const where = [eq(contacts.workspaceId, workspaceId)];
      if (q) {
        const like = `%${likeEscape(q)}%`;
        where.push(sql`(
          ${contacts.firstName} ilike ${like} or ${contacts.lastName} ilike ${like}
          or ${contacts.email} ilike ${like} or ${contacts.phone} ilike ${like}
          or exists (select 1 from contact_identities ci where ci.contact_id = ${CONTACT_ID} and ci.username ilike ${like}))`);
      }
      if (tag) {
        where.push(sql`exists (select 1 from contact_tags ct join tags t on t.id = ct.tag_id
          where ct.contact_id = ${CONTACT_ID} and lower(t.name) = lower(${tag}))`);
      }
      return and(...where);
    };

    app.get('/contacts', async (req) => {
      const { workspace } = who(req);
      const query = listQuery.parse(req.query);
      const where = filters(workspace.id, query.q, query.tag);
      const [rows, [total]] = await Promise.all([
        db
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            phone: contacts.phone,
            username: usernameOf,
            avatarVersion: avatarVersionOf,
            tags: tagsOf,
            channels: channelsOf,
            automationPausedAt: contacts.automationPausedAt,
            automationResumeAt: contacts.automationResumeAt,
            lastSeenAt: contacts.lastSeenAt,
            createdAt: contacts.createdAt,
          })
          .from(contacts)
          .where(where)
          .orderBy(sql`${contacts.lastSeenAt} desc nulls last`, desc(contacts.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ n: count() }).from(contacts).where(where),
      ]);
      return { contacts: rows, total: total?.n ?? 0 };
    });

    /** Their profile picture, kept from the channel. Cached for good: the URL carries ?v=. */
    app.get('/contacts/:id/avatar', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [avatar] = await db
        .select({ contentType: contactAvatars.contentType, data: contactAvatars.data })
        .from(contactAvatars)
        .where(and(eq(contactAvatars.contactId, id), eq(contactAvatars.workspaceId, workspace.id)));
      if (!avatar) throw notFound('Picture');
      return reply
        .header('content-type', avatar.contentType)
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(avatar.data);
    });

    // Registered before /contacts/:id so "export.csv" isn't taken for an id.
    app.get('/contacts/export.csv', async (req, reply) => {
      const { workspace } = who(req);
      const defs = await db
        .select({ key: fieldDefinitions.key })
        .from(fieldDefinitions)
        .where(eq(fieldDefinitions.workspaceId, workspace.id))
        .orderBy(asc(fieldDefinitions.createdAt));
      const consentOf = (channel: string) => sql<boolean | null>`(
        select c.granted from consents c where c.contact_id = ${CONTACT_ID} and c.channel = ${channel}
        order by c.created_at desc limit 1)`;

      let out = csvRow([
        'id',
        'first_name',
        'last_name',
        'email',
        'phone',
        'username',
        'tags',
        'channels',
        'email_consent',
        'sms_consent',
        'created_at',
        'last_seen_at',
        ...defs.map((d) => d.key),
      ]);
      const PAGE = 1000;
      for (let offset = 0; ; offset += PAGE) {
        const page = await db
          .select({
            c: contacts,
            username: usernameOf,
            tags: tagsOf,
            channels: channelsOf,
            emailConsent: consentOf('email'),
            smsConsent: consentOf('sms'),
          })
          .from(contacts)
          .where(eq(contacts.workspaceId, workspace.id))
          .orderBy(asc(contacts.createdAt), asc(contacts.id))
          .limit(PAGE)
          .offset(offset);
        for (const r of page) {
          out += csvRow([
            r.c.id,
            r.c.firstName,
            r.c.lastName,
            r.c.email,
            r.c.phone,
            r.username,
            r.tags.join('; '),
            r.channels.join('; '),
            r.emailConsent,
            r.smsConsent,
            r.c.createdAt,
            r.c.lastSeenAt,
            ...defs.map((d) => r.c.customFields[d.key]),
          ]);
        }
        if (page.length < PAGE) break;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="contacts-${stamp}.csv"`)
        .send(out);
    });

    app.get('/contacts/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [row] = await db
        .select({ c: contacts, tags: tagsOf, avatarVersion: avatarVersionOf })
        .from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspace.id)));
      if (!row) throw notFound('Contact');

      const [identities, consentRows, events, recentRuns, defs] = await Promise.all([
        db
          .select({
            channel: contactIdentities.channel,
            externalId: contactIdentities.externalId,
            username: contactIdentities.username,
            displayName: contactIdentities.displayName,
            followsUs: contactIdentities.followsUs,
            weFollow: contactIdentities.weFollow,
            followerCount: contactIdentities.followerCount,
            verified: contactIdentities.verified,
            profileSyncedAt: contactIdentities.profileSyncedAt,
          })
          .from(contactIdentities)
          .where(eq(contactIdentities.contactId, id)),
        db
          .selectDistinctOn([consents.channel], {
            channel: consents.channel,
            granted: consents.granted,
            source: consents.source,
            at: consents.createdAt,
          })
          .from(consents)
          .where(eq(consents.contactId, id))
          .orderBy(consents.channel, desc(consents.createdAt)),
        db
          .select({
            id: contactEvents.id,
            type: contactEvents.type,
            data: contactEvents.data,
            at: contactEvents.createdAt,
          })
          .from(contactEvents)
          .where(eq(contactEvents.contactId, id))
          .orderBy(desc(contactEvents.createdAt), desc(contactEvents.id))
          .limit(100),
        db
          .select({
            id: runs.id,
            flowId: runs.flowId,
            flowName: flows.name,
            status: runs.status,
            startedAt: runs.startedAt,
            endedAt: runs.endedAt,
            error: runs.error,
          })
          .from(runs)
          .innerJoin(flows, eq(flows.id, runs.flowId))
          .where(eq(runs.contactId, id))
          .orderBy(desc(runs.startedAt))
          .limit(20),
        db
          .select({
            key: fieldDefinitions.key,
            label: fieldDefinitions.label,
            type: fieldDefinitions.type,
          })
          .from(fieldDefinitions)
          .where(eq(fieldDefinitions.workspaceId, workspace.id))
          .orderBy(asc(fieldDefinitions.createdAt)),
      ]);
      const { c } = row;
      return {
        contact: {
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          phone: c.phone,
          avatarVersion: row.avatarVersion,
          tags: row.tags,
          fields: defs.map((d) => ({ ...d, value: c.customFields[d.key] ?? null })),
          automationPausedAt: c.automationPausedAt,
          automationResumeAt: c.automationResumeAt,
          lastSeenAt: c.lastSeenAt,
          createdAt: c.createdAt,
        },
        identities,
        consents: consentRows,
        events,
        runs: recentRuns,
      };
    });

    /** Loads the contact under its lock, checking it belongs to the caller's workspace. */
    const withContact = async <T>(
      workspaceId: string,
      contactId: string,
      fn: (tx: Tx) => Promise<T>,
    ) =>
      db.transaction(async (tx) => {
        await lockContact(tx, contactId);
        const [c] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)));
        if (!c) throw notFound('Contact');
        return fn(tx);
      });

    app.patch('/contacts/:id', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const body = patchBody.parse(req.body);
      await withContact(workspace.id, id, async (tx) => {
        const snapshot = await loadSnapshot(tx, id, 'manual');
        const fields = { ...snapshot.fields };
        if (body.firstName !== undefined) fields.first_name = body.firstName;
        if (body.lastName !== undefined) fields.last_name = body.lastName;
        if (body.email !== undefined) fields.email = body.email;
        if (body.phone !== undefined) fields.phone = body.phone;
        for (const [key, value] of Object.entries(body.fields ?? {})) {
          if (!(SYSTEM_FIELDS as readonly string[]).includes(key)) fields[key] = value;
        }
        await saveFields(tx, workspace.id, id, fields);
        await recordEvent(tx, workspace.id, id, 'contact_edited', {
          by: user.id,
          changed: Object.keys(body),
        });
      });
      return { ok: true };
    });

    app.post('/contacts/:id/tags', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { tag } = z.object({ tag: tagName }).parse(req.body);
      await withContact(workspace.id, id, async (tx) => {
        if (await addTag(tx, workspace.id, id, tag))
          await recordEvent(tx, workspace.id, id, 'tag_added', { tag, by: user.id });
      });
      return { ok: true };
    });

    app.delete('/contacts/:id/tags/:tag', async (req) => {
      const { user, workspace } = who(req);
      const { id, tag } = z.object({ id: z.uuid(), tag: tagName }).parse(req.params);
      await withContact(workspace.id, id, async (tx) => {
        if (await removeTag(tx, workspace.id, id, tag))
          await recordEvent(tx, workspace.id, id, 'tag_removed', { tag, by: user.id });
      });
      return { ok: true };
    });

    app.post('/contacts/:id/consent', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { channel, granted } = z
        .object({ channel: z.enum(['email', 'sms']), granted: z.boolean() })
        .parse(req.body);
      await withContact(workspace.id, id, async (tx) => {
        await tx.insert(consents).values({
          workspaceId: workspace.id,
          contactId: id,
          channel,
          granted,
          source: `manual:${user.id}`,
        });
        await recordEvent(tx, workspace.id, id, 'consent_changed', {
          channel,
          granted,
          by: user.id,
        });
      });
      return { ok: true };
    });

    /** Turns automation off for this contact until someone resumes it, like a hand-off. */
    app.post('/contacts/:id/pause-automation', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await withContact(workspace.id, id, async (tx) => {
        const now = new Date();
        await tx
          .update(contacts)
          .set({ automationPausedAt: now, automationResumeAt: null })
          .where(eq(contacts.id, id));
        await tx
          .update(runs)
          .set({ status: 'cancelled', endedAt: now, updatedAt: now, wakeAt: null })
          .where(and(eq(runs.contactId, id), eq(runs.status, 'waiting')));
        await recordEvent(tx, workspace.id, id, 'automation_paused', { by: user.id });
      });
      return { ok: true };
    });

    /** Turns automation back on after a hand-off, or before a person-replied pause runs out. */
    app.post('/contacts/:id/resume-automation', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await withContact(workspace.id, id, async (tx) => {
        await tx
          .update(contacts)
          .set({ automationPausedAt: null, automationResumeAt: null })
          .where(eq(contacts.id, id));
        await recordEvent(tx, workspace.id, id, 'automation_resumed', { by: user.id });
      });
      return { ok: true };
    });

    /** Permanently deletes the contact and everything about them (messages, runs, events). */
    app.delete('/contacts/:id', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await withContact(workspace.id, id, (tx) => tx.delete(contacts).where(eq(contacts.id, id)));
      return reply.code(204).send();
    });
  };
