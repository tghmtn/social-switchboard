import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  type ApiCall,
  advance,
  CHANGING_TOOLS,
  decide,
  describeGraph,
  describeTrigger,
} from '../ai/assistant';
import { AI_MODELS, DEFAULT_EFFORT, EFFORTS, estimateCost, modelFor } from '../ai/models';
import type { RouteDeps } from '../app';
import { SESSION_COOKIE } from '../auth/sessions';
import { decryptSecret, encryptSecret } from '../crypto';
import { aiActions, aiUsage, assistantThreads, flows, workspaces } from '../db/schema';
import { notFound, requireAdmin, requireWorkspace, who } from './guard';

// The AI settings (bring your own Anthropic key) and the in-app assistant's conversations.
// A turn runs in the background and the panel checks back, so a long answer can't hit a proxy's
// request timeout.

/** Threads with a turn running in this process. */
const running = new Set<string>();

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown };
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  is_error?: boolean;
  content?: unknown;
};

const READ_LABELS: Record<string, string> = {
  get_overview: 'Checked your setup',
  list_flows: 'Looked at your flows',
  get_flow: 'Opened a flow',
  list_posts: 'Looked at your posts',
  find_contacts: 'Searched contacts',
  get_contact_history: 'Read a conversation',
  get_setup_guide: 'Read the setup guide',
  check_file_link: 'Checked a file link',
};

const CONTEXT = '<context>';

export const assistantRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    // ------------------------------------------------------------ settings

    const aiSettings = async (workspaceId: string) => {
      const [ws] = await db
        .select({
          model: workspaces.aiModel,
          effort: workspaces.aiEffort,
          keyEnc: workspaces.aiKeyEnc,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return {
        model: modelFor(ws?.model).id,
        effort: ws?.effort ?? DEFAULT_EFFORT,
        hasKey: Boolean(ws?.keyEnc),
        models: AI_MODELS.map(({ id, label, note, input, output }) => ({
          id,
          label,
          note,
          input,
          output,
        })),
        efforts: EFFORTS,
      };
    };

    app.get('/settings/ai', async (req) => aiSettings(who(req).workspace.id));

    app.put('/settings/ai', async (req) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          model: z.enum(AI_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
          effort: z.enum(EFFORTS).optional(),
          /** A new key, or null to remove it; leave it out to keep the saved one. */
          apiKey: z
            .string()
            .trim()
            .regex(
              /^sk-ant-[\w-]{20,}$/,
              'That doesn’t look like an Anthropic API key (it starts with sk-ant-).',
            )
            .nullable()
            .optional(),
        })
        .parse(req.body);
      await db
        .update(workspaces)
        .set({
          ...(body.model ? { aiModel: body.model } : {}),
          ...(body.effort ? { aiEffort: body.effort } : {}),
          ...(body.apiKey !== undefined
            ? { aiKeyEnc: body.apiKey ? encryptSecret(config.appSecret, body.apiKey) : null }
            : {}),
        })
        .where(eq(workspaces.id, workspace.id));
      return aiSettings(workspace.id);
    });

    /** Checks the saved key can use the chosen model (a lookup, no tokens spent). */
    app.post('/settings/ai/test', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const [ws] = await db
        .select({ model: workspaces.aiModel, keyEnc: workspaces.aiKeyEnc })
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      if (!ws?.keyEnc) return reply.code(409).send({ error: 'Save an API key first.' });
      try {
        const client = new Anthropic({
          apiKey: decryptSecret(config.appSecret, ws.keyEnc),
          timeout: 15_000,
        });
        const model = await client.models.retrieve(modelFor(ws.model).id);
        return { ok: true, model: model.display_name };
      } catch (err) {
        const message =
          err instanceof Anthropic.AuthenticationError
            ? 'Anthropic refused that key.'
            : err instanceof Anthropic.NotFoundError ||
                err instanceof Anthropic.PermissionDeniedError
              ? 'That key works, but can’t use this model. Pick another one.'
              : 'Couldn’t reach Anthropic. Try again in a moment.';
        return reply.code(502).send({ error: message });
      }
    });

    /** What the AI has used (estimated from list prices) and the latest things it did. */
    app.get('/settings/ai/usage', async (req) => {
      const { workspace } = who(req);
      const since = new Date();
      since.setUTCDate(1);
      since.setUTCHours(0, 0, 0, 0);
      const [rows, actions] = await Promise.all([
        db
          .select({
            model: aiUsage.model,
            requests: sql<number>`count(*)::int`,
            input: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
            output: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
            cacheRead: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::int`,
            cacheWrite: sql<number>`coalesce(sum(${aiUsage.cacheWriteTokens}), 0)::int`,
          })
          .from(aiUsage)
          .where(and(eq(aiUsage.workspaceId, workspace.id), gte(aiUsage.createdAt, since)))
          .groupBy(aiUsage.model),
        db
          .select({
            tool: aiActions.tool,
            decision: aiActions.decision,
            ok: aiActions.ok,
            summary: aiActions.summary,
            at: aiActions.createdAt,
          })
          .from(aiActions)
          .where(eq(aiActions.workspaceId, workspace.id))
          .orderBy(desc(aiActions.createdAt))
          .limit(20),
      ]);
      return {
        since,
        models: rows.map((r) => ({
          ...r,
          label: modelFor(r.model).label,
          estimatedCost: estimateCost(r.model, r),
        })),
        actions,
      };
    });

    // ------------------------------------------------------------ threads

    const ownThread = async (userId: string, workspaceId: string, id: string) => {
      const [t] = await db
        .select()
        .from(assistantThreads)
        .where(
          and(
            eq(assistantThreads.id, id),
            eq(assistantThreads.userId, userId),
            eq(assistantThreads.workspaceId, workspaceId),
          ),
        );
      if (!t) throw notFound('Conversation');
      return t;
    };

    /** The conversation as the panel shows it: words, the tools used, and changes awaiting a yes. */
    const view = async (t: typeof assistantThreads.$inferSelect) => {
      // A turn that was running when the server restarted won't finish.
      if (t.status === 'working' && !running.has(t.id)) {
        t.status = 'error';
        t.error = 'This was interrupted. Send your message again.';
        await db
          .update(assistantThreads)
          .set({ status: t.status, error: t.error })
          .where(eq(assistantThreads.id, t.id));
      }
      const messages = t.messages as { role: string; content: string | Block[] }[];
      const flowIds = new Set<string>();
      for (const m of messages)
        if (Array.isArray(m.content))
          for (const b of m.content) {
            const input = b.input as { flowId?: unknown } | undefined;
            if (b.type === 'tool_use' && typeof input?.flowId === 'string')
              flowIds.add(input.flowId);
          }
      const ids = [...flowIds].filter((x) => z.uuid().safeParse(x).success);
      const names = new Map(
        ids.length
          ? (
              await db
                .select({ id: flows.id, name: flows.name })
                .from(flows)
                .where(and(inArray(flows.id, ids), eq(flows.workspaceId, t.workspaceId)))
            ).map((f) => [f.id, f.name])
          : [],
      );
      const flowName = (input: unknown) => {
        const fid = (input as { flowId?: string }).flowId;
        return fid && names.get(fid) ? `“${names.get(fid)}”` : 'a flow';
      };

      type Item =
        | { type: 'user' | 'assistant'; text: string }
        | {
            type: 'tool';
            id: string;
            label: string;
            state: 'running' | 'done' | 'failed' | 'declined' | 'waiting';
            changes: boolean;
            detail: string[];
            error?: string;
          };
      const items: Item[] = [];
      const tools = new Map<string, Extract<Item, { type: 'tool' }>>();
      const pendingIds = new Set(t.pending?.calls.map((c) => c.id) ?? []);
      for (const m of messages) {
        const blocks: Block[] =
          typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        for (const b of blocks) {
          if (b.type === 'text' && b.text && !b.text.startsWith(CONTEXT))
            items.push({ type: m.role === 'user' ? 'user' : 'assistant', text: b.text });
          if (b.type === 'tool_use' && b.id && b.name) {
            const input = (b.input ?? {}) as Record<string, unknown>;
            const changes = CHANGING_TOOLS.has(b.name);
            const graph = input.graph as { nodes: unknown[]; edges: unknown[] } | undefined;
            const label =
              b.name === 'create_flow'
                ? `Create the flow “${String(input.name)}”`
                : b.name === 'update_flow'
                  ? `Change ${flowName(input)}${input.name ? `, renamed “${String(input.name)}”` : ''}`
                  : b.name === 'add_trigger'
                    ? `Add a trigger to ${flowName(input)}`
                    : b.name === 'set_trigger_enabled'
                      ? `Turn a trigger ${input.enabled ? 'on' : 'off'}`
                      : b.name === 'publish_flow'
                        ? `Publish ${flowName(input)}`
                        : (READ_LABELS[b.name] ?? b.name);
            const detail =
              graph && Array.isArray(graph.nodes)
                ? describeGraph(graph)
                : b.name === 'add_trigger' && input.config
                  ? [describeTrigger(input.config as Record<string, unknown>)]
                  : b.name === 'publish_flow'
                    ? ['Its triggers start answering real people.']
                    : b.name === 'find_contacts' && input.query
                      ? [`“${String(input.query)}”`]
                      : [];
            const item: Extract<Item, { type: 'tool' }> = {
              type: 'tool',
              id: b.id,
              label,
              state: pendingIds.has(b.id) ? 'waiting' : 'running',
              changes,
              detail,
            };
            tools.set(b.id, item);
            items.push(item);
          }
          if (b.type === 'tool_result') {
            const r = b as unknown as ToolResultBlock;
            const item = tools.get(r.tool_use_id);
            if (!item) continue;
            const text = typeof r.content === 'string' ? r.content : '';
            if (text.startsWith('The person declined')) item.state = 'declined';
            else if (r.is_error) {
              item.state = 'failed';
              item.error = text.split('\n')[0];
            } else item.state = 'done';
          }
        }
      }
      // Reading tools in a turn that's waiting on approval have run already.
      for (const r of t.pending?.results ?? []) {
        const item = tools.get(r.tool_use_id);
        if (item) item.state = r.is_error ? 'failed' : 'done';
      }
      return { id: t.id, title: t.title, status: t.status, error: t.error, items };
    };

    /** The app's own API, as this person: same checks and permissions as clicking in the UI. */
    const apiAs =
      (token: string): ApiCall =>
      async (method, url, payload) => {
        const res = await app.inject({
          method,
          url,
          payload,
          cookies: { [SESSION_COOKIE]: token },
        });
        let body: unknown = null;
        try {
          body = res.json();
        } catch {
          body = res.body;
        }
        return { status: res.statusCode, body };
      };

    const start = (
      req: Parameters<typeof who>[0],
      threadId: string,
      run: (deps: Parameters<typeof advance>[0]) => Promise<void>,
    ) => {
      const { user, workspace } = who(req);
      const token = req.cookies[SESSION_COOKIE] ?? '';
      running.add(threadId);
      void run({
        db,
        appSecret: config.appSecret,
        api: apiAs(token),
        workspaceId: workspace.id,
        userId: user.id,
        log: (msg, fields) => req.log.warn(fields ?? {}, msg),
      })
        .catch((err: unknown) => req.log.error({ err: String(err) }, 'assistant turn failed'))
        .finally(() => running.delete(threadId));
    };

    app.get('/assistant/threads', async (req) => {
      const { user, workspace } = who(req);
      const threads = await db
        .select({
          id: assistantThreads.id,
          title: assistantThreads.title,
          updatedAt: assistantThreads.updatedAt,
        })
        .from(assistantThreads)
        .where(
          and(eq(assistantThreads.userId, user.id), eq(assistantThreads.workspaceId, workspace.id)),
        )
        .orderBy(desc(assistantThreads.updatedAt))
        .limit(30);
      return { threads };
    });

    app.post('/assistant/threads', async (req, reply) => {
      const { user, workspace } = who(req);
      const [t] = await db
        .insert(assistantThreads)
        .values({ workspaceId: workspace.id, userId: user.id })
        .returning();
      if (!t) throw new Error('thread insert returned no row');
      return reply.code(201).send(await view(t));
    });

    app.get('/assistant/threads/:id', async (req) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      return view(await ownThread(user.id, workspace.id, id));
    });

    app.post('/assistant/threads/:id/messages', async (req, reply) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const body = z
        .object({ text: z.string().trim().min(1).max(4000), page: z.string().max(200).optional() })
        .parse(req.body);
      const t = await ownThread(user.id, workspace.id, id);
      if (running.has(id) || t.status === 'working')
        return reply.code(409).send({ error: 'Still working on the last message.' });
      if (t.status === 'waiting')
        return reply.code(409).send({ error: 'Approve or decline the proposed change first.' });
      const [ws] = await db
        .select({
          name: workspaces.name,
          timeZone: workspaces.timeZone,
          keyEnc: workspaces.aiKeyEnc,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      if (!ws?.keyEnc)
        return reply.code(409).send({ error: 'Add an Anthropic API key in Settings → AI first.' });
      const first = (t.messages as unknown[]).length === 0;
      const today = new Date().toLocaleDateString('en-CA', { timeZone: ws.timeZone });
      const context = [
        first &&
          `Today is ${today} (workspace time zone ${ws.timeZone}). You're helping ${user.name}, an ${workspace.role === 'agent' ? 'agent' : workspace.role} in the workspace “${ws.name}”.${workspace.role === 'agent' ? ' Agents can’t change channel, team or notification settings.' : ''}`,
        body.page && `They’re on this page of the app: ${body.page}`,
      ].filter(Boolean);
      const content = [
        ...(context.length
          ? [{ type: 'text', text: `${CONTEXT}${context.join('\n')}</context>` }]
          : []),
        { type: 'text', text: body.text },
      ];
      const messages = [...(t.messages as unknown[]), { role: 'user', content }];
      const [saved] = await db
        .update(assistantThreads)
        .set({
          messages,
          status: 'working',
          error: null,
          ...(t.title ? {} : { title: body.text.slice(0, 80) }),
          updatedAt: new Date(),
        })
        .where(eq(assistantThreads.id, id))
        .returning();
      if (!saved) throw notFound('Conversation');
      start(req, id, (deps) => advance(deps, id));
      return reply.code(202).send(await view(saved));
    });

    /** Approve or decline the change(s) the assistant proposed. */
    app.post('/assistant/threads/:id/decide', async (req, reply) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { approve } = z.object({ approve: z.array(z.string()).max(20) }).parse(req.body);
      const t = await ownThread(user.id, workspace.id, id);
      if (t.status !== 'waiting' || !t.pending || running.has(id))
        return reply.code(409).send({ error: 'Nothing is waiting for a decision.' });
      await db
        .update(assistantThreads)
        .set({ status: 'working', updatedAt: new Date() })
        .where(eq(assistantThreads.id, id));
      start(req, id, (deps) => decide(deps, id, new Set(approve)));
      return reply.code(202).send(await view({ ...t, status: 'working' }));
    });
  };
