import {
  type FlowIssue,
  flowGraph,
  HANDLE_PLACEHOLDER,
  STARTERS,
  triggerConfig,
  validateFlow,
} from '@social-switchboard/flow';
import { and, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import type { Db, Tx } from '../db/client';
import { flows, flowVersions, instagramAccounts, runs, triggers } from '../db/schema';
import { notFound, requireWorkspace, who } from './guard';

const idParam = z.object({ id: z.uuid() });
// Name the outer row explicitly inside select-list subqueries (see CONTACT_ID in contacts.ts).
const FLOW_ID = sql.raw('"flows"."id"');
const channelList = z.array(z.string().trim().min(1).max(40)).max(20).nullable();

/** Wiring checks plus the ones that need the database (does the "go to" flow exist?). */
async function checkFlow(
  db: Db | Tx,
  workspaceId: string,
  graph: z.infer<typeof flowGraph>,
): Promise<FlowIssue[]> {
  const issues = validateFlow(graph);
  const targets = graph.nodes.flatMap((n) =>
    n.type === 'goto_flow' ? [{ node: n.id, flow: n.data.flowId }] : [],
  );
  if (targets.length > 0) {
    const ids = targets.map((t) => t.flow).filter((id) => z.uuid().safeParse(id).success);
    const found = ids.length
      ? await db
          .select({ id: flows.id })
          .from(flows)
          .where(
            and(
              eq(flows.workspaceId, workspaceId),
              isNull(flows.archivedAt),
              inArray(flows.id, ids),
            ),
          )
      : [];
    const known = new Set(found.map((f) => f.id));
    for (const t of targets) {
      if (!known.has(t.flow)) {
        issues.push({
          severity: 'error',
          code: 'edge_unknown_node',
          message: 'This step goes to an automation that doesn’t exist.',
          nodeId: t.node,
        });
      }
    }
  }
  return issues;
}

export const flowRoutes =
  ({ db }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    const ownFlow = async (workspaceId: string, id: string) => {
      const [flow] = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId), isNull(flows.archivedAt)));
      if (!flow) throw notFound('Automation');
      return flow;
    };

    app.get('/flow-starters', async () => ({
      starters: STARTERS.map(({ key, name, description, trigger }) => ({
        key,
        name,
        description,
        trigger,
      })),
    }));

    app.get('/flows', async (req) => {
      const { workspace } = who(req);
      const rows = await db
        .select({
          id: flows.id,
          name: flows.name,
          draft: flows.draft,
          published: flowVersions.graph,
          publishedNumber: flowVersions.number,
          updatedAt: flows.updatedAt,
          triggers: sql<number>`(select count(*)::int from triggers t where t.flow_id = ${FLOW_ID})`,
          activeRuns: sql<number>`(select count(*)::int from runs r where r.flow_id = ${FLOW_ID} and r.status = 'waiting')`,
          totalRuns: sql<number>`(select count(*)::int from runs r where r.flow_id = ${FLOW_ID})`,
        })
        .from(flows)
        .leftJoin(flowVersions, eq(flowVersions.id, flows.publishedVersionId))
        .where(and(eq(flows.workspaceId, workspace.id), isNull(flows.archivedAt)))
        .orderBy(desc(flows.updatedAt));
      return {
        flows: rows.map(({ draft, published, ...r }) => ({
          ...r,
          // Both sides come back from jsonb, so key order matches and a string compare is enough.
          hasUnpublishedChanges: !published || JSON.stringify(draft) !== JSON.stringify(published),
        })),
      };
    });

    app.post('/flows', async (req, reply) => {
      const { workspace } = who(req);
      const body = z
        .object({
          name: z.string().trim().min(1).max(100),
          starter: z.enum(STARTERS.map((s) => s.key) as [string, ...string[]]).default('blank'),
        })
        .parse(req.body);
      const starter = STARTERS.find((s) => s.key === body.starter) ?? STARTERS.at(-1);
      // A starter's links to "your" Instagram profile point at the connected account.
      const [account] = await db
        .select({ username: instagramAccounts.username })
        .from(instagramAccounts)
        .where(eq(instagramAccounts.workspaceId, workspace.id))
        .orderBy(instagramAccounts.connectedAt)
        .limit(1);
      const handle = account?.username;
      const graph = flowGraph.parse(
        handle
          ? JSON.parse(JSON.stringify(starter?.graph).replaceAll(HANDLE_PLACEHOLDER, handle))
          : starter?.graph,
      );
      const flow = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(flows)
          .values({ workspaceId: workspace.id, name: body.name, draft: graph })
          .returning();
        if (!created) throw new Error('flow insert returned no row');
        if (starter?.trigger) {
          await tx
            .insert(triggers)
            .values({ workspaceId: workspace.id, flowId: created.id, config: starter.trigger });
        }
        return created;
      });
      return reply.code(201).send({ flow });
    });

    /** Copies the draft and its triggers into a new, unpublished automation. */
    app.post('/flows/:id/duplicate', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const original = await ownFlow(workspace.id, id);
      const flow = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(flows)
          .values({
            workspaceId: workspace.id,
            name: `${original.name.slice(0, 93)} (copy)`,
            draft: original.draft,
          })
          .returning();
        if (!created) throw new Error('flow insert returned no row');
        const copies = await tx
          .select()
          .from(triggers)
          .where(eq(triggers.flowId, id))
          .orderBy(triggers.position, triggers.createdAt);
        if (copies.length > 0) {
          // After every other trigger, so the original keeps answering until the copy changes.
          const [last] = await tx
            .select({ n: max(triggers.position) })
            .from(triggers)
            .where(eq(triggers.workspaceId, workspace.id));
          await tx.insert(triggers).values(
            copies.map((t, i) => ({
              workspaceId: workspace.id,
              flowId: created.id,
              config: t.config,
              channels: t.channels,
              enabled: t.enabled,
              position: (last?.n ?? 0) + 1 + i,
            })),
          );
        }
        return created;
      });
      return reply.code(201).send({ flow });
    });

    app.get('/flows/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const flow = await ownFlow(workspace.id, id);
      const [issues, flowTriggers, versions] = await Promise.all([
        checkFlow(db, workspace.id, flow.draft),
        db
          .select()
          .from(triggers)
          .where(eq(triggers.flowId, id))
          .orderBy(triggers.position, triggers.createdAt),
        db
          .select({
            id: flowVersions.id,
            number: flowVersions.number,
            createdAt: flowVersions.createdAt,
          })
          .from(flowVersions)
          .where(and(eq(flowVersions.flowId, id), eq(flowVersions.kind, 'published')))
          .orderBy(desc(flowVersions.number))
          .limit(20),
      ]);
      // Whether the draft differs from what's live (the same test as the flows list).
      const [live] = flow.publishedVersionId
        ? await db
            .select({ graph: flowVersions.graph })
            .from(flowVersions)
            .where(eq(flowVersions.id, flow.publishedVersionId))
        : [];
      const hasUnpublishedChanges =
        !live || JSON.stringify(flow.draft) !== JSON.stringify(live.graph);
      return { flow, issues, triggers: flowTriggers, versions, hasUnpublishedChanges };
    });

    /** Saves the builder's working copy. Wiring problems are returned, not rejected. */
    app.put('/flows/:id/draft', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const parsed = flowGraph.safeParse((req.body as { graph?: unknown } | undefined)?.graph);
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid_graph', issues: parsed.error.issues });
      await ownFlow(workspace.id, id);
      await db
        .update(flows)
        .set({ draft: parsed.data, updatedAt: new Date() })
        .where(eq(flows.id, id));
      return { issues: await checkFlow(db, workspace.id, parsed.data) };
    });

    app.patch('/flows/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
      await ownFlow(workspace.id, id);
      const [flow] = await db
        .update(flows)
        .set({ name, updatedAt: new Date() })
        .where(eq(flows.id, id))
        .returning();
      return { flow };
    });

    app.post('/flows/:id/publish', async (req, reply) => {
      const { user, workspace } = who(req);
      const { id } = idParam.parse(req.params);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`flow:${id}`}, 0))`);
        const [flow] = await tx
          .select()
          .from(flows)
          .where(
            and(eq(flows.id, id), eq(flows.workspaceId, workspace.id), isNull(flows.archivedAt)),
          );
        if (!flow) throw notFound('Automation');
        const issues = await checkFlow(tx, workspace.id, flow.draft);
        if (issues.some((i) => i.severity === 'error'))
          return reply.code(422).send({ error: 'flow_has_errors', issues });

        const [last] = await tx
          .select({ n: max(flowVersions.number) })
          .from(flowVersions)
          .where(and(eq(flowVersions.flowId, id), eq(flowVersions.kind, 'published')));
        const [version] = await tx
          .insert(flowVersions)
          .values({
            workspaceId: workspace.id,
            flowId: id,
            kind: 'published',
            number: (last?.n ?? 0) + 1,
            graph: flow.draft,
            createdBy: user.id,
          })
          .returning({ id: flowVersions.id, number: flowVersions.number });
        if (!version) throw new Error('version insert returned no row');
        await tx
          .update(flows)
          .set({ publishedVersionId: version.id, updatedAt: new Date() })
          .where(eq(flows.id, id));
        return { version, issues };
      });
    });

    /** Archives the flow and stops its runs. History stays for analytics. */
    app.delete('/flows/:id', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      await ownFlow(workspace.id, id);
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(flows).set({ archivedAt: now, updatedAt: now }).where(eq(flows.id, id));
        await tx
          .update(runs)
          .set({ status: 'cancelled', endedAt: now, updatedAt: now, wakeAt: null })
          .where(and(eq(runs.flowId, id), eq(runs.status, 'waiting')));
      });
      return reply.code(204).send();
    });

    // ------------------------------------------------------------ triggers

    app.get('/triggers', async (req) => {
      const { workspace } = who(req);
      const rows = await db
        .select({
          trigger: triggers,
          flowName: flows.name,
          published: sql<boolean>`${flows.publishedVersionId} is not null`,
        })
        .from(triggers)
        .innerJoin(flows, eq(flows.id, triggers.flowId))
        .where(and(eq(triggers.workspaceId, workspace.id), isNull(flows.archivedAt)))
        .orderBy(triggers.position, triggers.createdAt);
      return {
        triggers: rows.map((r) => ({
          ...r.trigger,
          flowName: r.flowName,
          flowPublished: r.published,
        })),
      };
    });

    app.post('/triggers', async (req, reply) => {
      const { workspace } = who(req);
      const body = z
        .object({
          flowId: z.uuid(),
          config: triggerConfig,
          channels: channelList.default(null),
          enabled: z.boolean().default(true),
        })
        .parse(req.body);
      await ownFlow(workspace.id, body.flowId);
      const [last] = await db
        .select({ n: max(triggers.position) })
        .from(triggers)
        .where(eq(triggers.workspaceId, workspace.id));
      const [trigger] = await db
        .insert(triggers)
        .values({ ...body, workspaceId: workspace.id, position: (last?.n ?? 0) + 1 })
        .returning();
      return reply.code(201).send({ trigger });
    });

    app.patch('/triggers/:id', async (req) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          flowId: z.uuid(),
          config: triggerConfig,
          channels: channelList,
          enabled: z.boolean(),
          position: z.number().int().min(0),
        })
        .partial()
        .parse(req.body);
      if (body.flowId) await ownFlow(workspace.id, body.flowId);
      const [trigger] = await db
        .update(triggers)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(triggers.id, id), eq(triggers.workspaceId, workspace.id)))
        .returning();
      if (!trigger) throw notFound('Trigger');
      return { trigger };
    });

    app.delete('/triggers/:id', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = idParam.parse(req.params);
      const deleted = await db
        .delete(triggers)
        .where(and(eq(triggers.id, id), eq(triggers.workspaceId, workspace.id)))
        .returning({ id: triggers.id });
      if (deleted.length === 0) throw notFound('Trigger');
      return reply.code(204).send();
    });
  };
