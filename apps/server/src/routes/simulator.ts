import { flowGraph } from '@social-switchboard/flow';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps, SessionUser } from '../app';
import { contactIdentities, contacts, flows, flowVersions, messages, runs } from '../db/schema';
import { findOrCreateContact, loadSnapshot } from '../runtime/contacts';
import { type Inbound, receive, startFlow, wake } from '../runtime/runtime';
import { notFound, requireWorkspace, who } from './guard';

// The simulator is a real channel ("simulator") with one contact per signed-in user. Everything
// goes through the same runtime Instagram will use, so a flow that works here works there.

const CHANNEL = 'simulator';
const externalIdFor = (user: SessionUser) => `user:${user.id}`;
const profileFor = (user: SessionUser) => {
  const [firstName, ...rest] = user.name.trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') || undefined };
};

export const simulatorRoutes =
  ({ db, runtime }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    const contactIdOf = async (workspaceId: string, user: SessionUser) => {
      const [row] = await db
        .select({ contactId: contactIdentities.contactId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.workspaceId, workspaceId),
            eq(contactIdentities.channel, CHANNEL),
            eq(contactIdentities.externalId, externalIdFor(user)),
          ),
        );
      return row?.contactId;
    };

    /** Everything the simulator panel shows: transcript, the contact as flows see it, and runs. */
    const state = async (workspaceId: string, user: SessionUser) => {
      const contactId = await contactIdOf(workspaceId, user);
      if (!contactId) return { contact: null, messages: [], runs: [] };
      const [snapshot, [row], transcript, recentRuns] = await Promise.all([
        db.transaction((tx) => loadSnapshot(tx, contactId, CHANNEL)),
        db
          .select({ pausedAt: contacts.automationPausedAt })
          .from(contacts)
          .where(eq(contacts.id, contactId)),
        db
          .select({
            id: messages.id,
            direction: messages.direction,
            status: messages.status,
            content: messages.content,
            error: messages.error,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.contactId, contactId))
          .orderBy(asc(messages.seq))
          .limit(500),
        db
          .select({
            id: runs.id,
            flowId: runs.flowId,
            flowName: flows.name,
            test: eq(flowVersions.kind, 'test'),
            status: runs.status,
            waitKind: runs.waitKind,
            wakeAt: runs.wakeAt,
            error: runs.error,
            startedAt: runs.startedAt,
          })
          .from(runs)
          .innerJoin(flows, eq(flows.id, runs.flowId))
          .innerJoin(flowVersions, eq(flowVersions.id, runs.flowVersionId))
          .where(eq(runs.contactId, contactId))
          .orderBy(desc(runs.startedAt))
          .limit(10),
      ]);
      return {
        contact: {
          id: contactId,
          tags: snapshot.tags,
          fields: snapshot.fields,
          automationPausedAt: row?.pausedAt ?? null,
        },
        messages: transcript,
        runs: recentRuns,
      };
    };

    const send = async (
      req: Parameters<typeof who>[0],
      input: Pick<Inbound, 'text' | 'payload' | 'ref'>,
    ) => {
      const { user, workspace } = who(req);
      await receive(runtime, {
        workspaceId: workspace.id,
        channel: CHANNEL,
        externalId: externalIdFor(user),
        profile: profileFor(user),
        ...input,
      });
      return state(workspace.id, user);
    };

    app.get('/simulator', async (req) => {
      const { user, workspace } = who(req);
      return state(workspace.id, user);
    });

    app.post('/simulator/send', async (req) => {
      const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
      return send(req, { text });
    });

    /** Tapping a quick reply or button sends its label as text plus its payload, like Instagram does. */
    app.post('/simulator/tap', async (req) => {
      const { payload, label } = z
        .object({ payload: z.string().min(1).max(1000), label: z.string().min(1).max(100) })
        .parse(req.body);
      return send(req, { payload, text: label });
    });

    /** Simulates opening an entry link like ig.me/m/you?ref=spring. */
    app.post('/simulator/open-link', async (req) => {
      const { ref } = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).parse(req.body);
      return send(req, { ref });
    });

    /** Runs a flow from the top: its current draft (to test before publishing) or the live version. */
    app.post('/simulator/start', async (req, reply) => {
      const { user, workspace } = who(req);
      const body = z
        .object({ flowId: z.uuid(), version: z.enum(['draft', 'published']).default('draft') })
        .parse(req.body);
      const [flow] = await db
        .select()
        .from(flows)
        .where(
          and(
            eq(flows.id, body.flowId),
            eq(flows.workspaceId, workspace.id),
            isNull(flows.archivedAt),
          ),
        );
      if (!flow) throw notFound('Flow');

      let versionId = flow.publishedVersionId;
      if (body.version === 'draft') {
        const [test] = await db
          .insert(flowVersions)
          .values({
            workspaceId: workspace.id,
            flowId: flow.id,
            kind: 'test',
            graph: flowGraph.parse(flow.draft),
            createdBy: user.id,
          })
          .returning({ id: flowVersions.id });
        versionId = test?.id ?? null;
      }
      if (!versionId) return reply.code(409).send({ error: 'not_published' });

      const contactId = await db.transaction(async (tx) => {
        const { contactId } = await findOrCreateContact(
          tx,
          workspace.id,
          CHANNEL,
          externalIdFor(user),
          profileFor(user),
        );
        // Testing should always run, even if an earlier test ended in a hand-off.
        await tx
          .update(contacts)
          .set({ automationPausedAt: null })
          .where(eq(contacts.id, contactId));
        return contactId;
      });
      await startFlow(runtime, {
        workspaceId: workspace.id,
        contactId,
        channel: CHANNEL,
        versionId,
      });
      return state(workspace.id, user);
    });

    /** Fires every pending delay and reply timeout now instead of waiting for it. */
    app.post('/simulator/fast-forward', async (req) => {
      const { user, workspace } = who(req);
      const contactId = await contactIdOf(workspace.id, user);
      if (contactId) {
        const waiting = await db
          .select({ id: runs.id, token: runs.wakeToken })
          .from(runs)
          .where(
            and(
              eq(runs.contactId, contactId),
              eq(runs.status, 'waiting'),
              isNotNull(runs.wakeToken),
            ),
          );
        for (const r of waiting) if (r.token) await wake(runtime, r.id, r.token);
      }
      return state(workspace.id, user);
    });

    app.post('/simulator/resume', async (req) => {
      const { user, workspace } = who(req);
      const contactId = await contactIdOf(workspace.id, user);
      if (contactId)
        await db
          .update(contacts)
          .set({ automationPausedAt: null })
          .where(eq(contacts.id, contactId));
      return state(workspace.id, user);
    });

    /** Forgets the simulator contact entirely: transcript, tags, fields and runs. */
    app.post('/simulator/reset', async (req) => {
      const { user, workspace } = who(req);
      const contactId = await contactIdOf(workspace.id, user);
      if (contactId) await db.delete(contacts).where(eq(contacts.id, contactId));
      return state(workspace.id, user);
    });
  };
