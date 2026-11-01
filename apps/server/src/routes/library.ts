import { fieldKey, SYSTEM_FIELDS, tagName } from '@social-switchboard/flow';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import {
  contacts,
  contactTags,
  fieldDefinitions,
  fieldType,
  savedReplies,
  tags,
} from '../db/schema';
import { conflict, notFound, requireWorkspace, who } from './guard';

// Custom fields and tags, the workspace's vocabulary for describing contacts; and saved replies,
// what the team often says in the inbox.

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string; cause?: { code?: string } }).code === '23505' ||
  (err as { cause?: { code?: string } }).cause?.code === '23505';

const fieldBody = z.object({
  key: fieldKey.refine(
    (k) => !(SYSTEM_FIELDS as readonly string[]).includes(k),
    'That key is built in.',
  ),
  label: z.string().trim().min(1).max(60),
  type: z.enum(fieldType.enumValues).default('text'),
  options: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});
const idParam = z.object({ id: z.uuid() });
const replyBody = z.object({
  title: z.string().trim().min(1, 'Give it a short name.').max(60),
  text: z.string().trim().min(1, 'Write the reply.').max(1000),
});

export const libraryRoutes =
  ({ db }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    app.get('/fields', async (req) => {
      const { workspace } = who(req);
      const rows = await db
        .select()
        .from(fieldDefinitions)
        .where(eq(fieldDefinitions.workspaceId, workspace.id))
        .orderBy(asc(fieldDefinitions.createdAt));
      return {
        system: SYSTEM_FIELDS.map((key) => ({
          key,
          label: key.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()),
        })),
        fields: rows,
      };
    });

    app.post('/fields', async (req, reply) => {
      const { workspace } = who(req);
      const body = fieldBody.parse(req.body);
      try {
        const [row] = await db
          .insert(fieldDefinitions)
          .values({ ...body, workspaceId: workspace.id })
          .returning();
        return reply.code(201).send({ field: row });
      } catch (err) {
        if (isUniqueViolation(err))
          throw conflict(`A field with the key "${body.key}" already exists.`);
        throw err;
      }
    });

    app.patch('/fields/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const body = fieldBody
        .pick({ label: true, type: true, options: true })
        .partial()
        .parse(req.body);
      const [row] = await db
        .update(fieldDefinitions)
        .set(body)
        .where(and(eq(fieldDefinitions.id, id), eq(fieldDefinitions.workspaceId, workspace.id)))
        .returning();
      if (!row) throw notFound('Field');
      return { field: row };
    });

    /** Deletes the field and clears its value from every contact. */
    app.delete('/fields/:id', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      await db.transaction(async (tx) => {
        const [row] = await tx
          .delete(fieldDefinitions)
          .where(and(eq(fieldDefinitions.id, id), eq(fieldDefinitions.workspaceId, workspace.id)))
          .returning({ key: fieldDefinitions.key });
        if (!row) throw notFound('Field');
        await tx
          .update(contacts)
          .set({ customFields: sql`${contacts.customFields} - ${row.key}` })
          .where(
            and(eq(contacts.workspaceId, workspace.id), sql`${contacts.customFields} ? ${row.key}`),
          );
      });
      return reply.code(204).send();
    });

    app.get('/tags', async (req) => {
      const { workspace } = who(req);
      const rows = await db
        .select({
          id: tags.id,
          name: tags.name,
          contacts: count(contactTags.contactId),
          createdAt: tags.createdAt,
        })
        .from(tags)
        .leftJoin(contactTags, eq(contactTags.tagId, tags.id))
        .where(eq(tags.workspaceId, workspace.id))
        .groupBy(tags.id)
        .orderBy(sql`lower(${tags.name})`);
      return { tags: rows };
    });

    app.post('/tags', async (req, reply) => {
      const { workspace } = who(req);
      const { name } = z.object({ name: tagName }).parse(req.body);
      const [row] = await db
        .insert(tags)
        .values({ workspaceId: workspace.id, name })
        .onConflictDoNothing()
        .returning();
      if (!row) throw conflict(`The tag "${name}" already exists.`);
      return reply.code(201).send({ tag: row });
    });

    app.patch('/tags/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const { name } = z.object({ name: tagName }).parse(req.body);
      try {
        const [row] = await db
          .update(tags)
          .set({ name })
          .where(and(eq(tags.id, id), eq(tags.workspaceId, workspace.id)))
          .returning();
        if (!row) throw notFound('Tag');
        return { tag: row };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`The tag "${name}" already exists.`);
        throw err;
      }
    });

    app.delete('/tags/:id', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const deleted = await db
        .delete(tags)
        .where(and(eq(tags.id, id), eq(tags.workspaceId, workspace.id)))
        .returning({ id: tags.id });
      if (deleted.length === 0) throw notFound('Tag');
      return reply.code(204).send();
    });

    /** Saved replies, by name. Anyone on the team can use and change them. */
    app.get('/saved-replies', async (req) => {
      const { workspace } = who(req);
      const rows = await db
        .select({
          id: savedReplies.id,
          title: savedReplies.title,
          text: savedReplies.text,
          updatedAt: savedReplies.updatedAt,
        })
        .from(savedReplies)
        .where(eq(savedReplies.workspaceId, workspace.id))
        .orderBy(sql`lower(${savedReplies.title})`);
      return { replies: rows };
    });

    app.post('/saved-replies', async (req, reply) => {
      const { user, workspace } = who(req);
      const body = replyBody.parse(req.body);
      const [row] = await db
        .insert(savedReplies)
        .values({ workspaceId: workspace.id, createdBy: user.id, ...body })
        .returning({ id: savedReplies.id, title: savedReplies.title, text: savedReplies.text });
      return reply.code(201).send({ reply: row });
    });

    app.put('/saved-replies/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const body = replyBody.parse(req.body);
      const [row] = await db
        .update(savedReplies)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(savedReplies.id, id), eq(savedReplies.workspaceId, workspace.id)))
        .returning({ id: savedReplies.id, title: savedReplies.title, text: savedReplies.text });
      if (!row) throw notFound('Saved reply');
      return { reply: row };
    });

    app.delete('/saved-replies/:id', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const gone = await db
        .delete(savedReplies)
        .where(and(eq(savedReplies.id, id), eq(savedReplies.workspaceId, workspace.id)))
        .returning({ id: savedReplies.id });
      if (gone.length === 0) throw notFound('Saved reply');
      return reply.code(204).send();
    });
  };
