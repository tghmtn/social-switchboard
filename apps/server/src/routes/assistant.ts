import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ANSWERED,
  type ApiCall,
  ASK_TOOL,
  advance,
  CHANGING_TOOLS,
  DECLINED,
  decide,
  describeGraph,
  describeTrigger,
  PAGE_PATH,
} from '../ai/assistant';
import {
  aiErrorText,
  checkModel,
  type ListedModel,
  listModels,
  suggestedModel,
  workspaceAi,
} from '../ai/client';
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_EFFORT,
  EFFORTS,
  estimateCost,
  PROVIDER_LABELS,
  PROVIDERS,
  type Provider,
  priceOf,
} from '../ai/models';
import type { RouteDeps } from '../app';
import { SESSION_COOKIE } from '../auth/sessions';
import { decryptSecret, encryptSecret } from '../crypto';
import { aiActions, aiUsage, assistantThreads, flows, triggers, workspaces } from '../db/schema';
import { notFound, requireAdmin, requireWorkspace, who } from './guard';

// The AI settings (bring your own Anthropic or OpenAI key) and the in-app assistant's conversations.
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
  list_flows: 'Looked at your automations',
  get_flow: 'Opened an automation',
  list_posts: 'Looked at your posts',
  find_contacts: 'Searched contacts',
  get_contact_history: 'Read a conversation',
  get_setup_guide: 'Read the setup guide',
  check_file_link: 'Checked a file link',
};

const PAGE_NAMES: [RegExp, string][] = [
  [/^\/(automations|flows)\/./, 'the automation'],
  [/^\/(automations|flows)$/, 'Automations'],
  [/^\/contacts\/./, 'the contact'],
  [/^\/contacts$/, 'Contacts'],
  [/^\/inbox\/./, 'the conversation'],
  [/^\/inbox$/, 'the Inbox'],
  [/^\/channels\/instagram$/, 'Instagram setup'],
  [/^\/channels\/facebook$/, 'Facebook setup'],
  [/^\/channels$/, 'Channels'],
  [/^\/simulator$/, 'the Simulator'],
  [/^\/settings$/, 'Settings'],
];
const pageName = (path: string) => PAGE_NAMES.find(([re]) => re.test(path))?.[1] ?? 'Today';

/** Model lists, per workspace, provider and key, for ten minutes. */
const modelCache = new Map<string, { at: number; models: ListedModel[] }>();
const modelsFor = async (cacheKey: string, provider: Provider, apiKey: string) => {
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.models;
  const models = await listModels(provider, apiKey);
  modelCache.set(cacheKey, { at: Date.now(), models });
  return models;
};

const modelId = z.string().regex(/^[\w.:-]{1,100}$/, 'That isn’t a model name.');

const CONTEXT = '<context>';

export const assistantRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    // ------------------------------------------------------------ settings

    const aiRow = async (workspaceId: string) => {
      const [ws] = await db
        .select({
          provider: workspaces.aiProvider,
          effort: workspaces.aiEffort,
          model: workspaces.aiModel,
          keyEnc: workspaces.aiKeyEnc,
          openaiModel: workspaces.aiOpenaiModel,
          openaiKeyEnc: workspaces.aiOpenaiKeyEnc,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return ws;
    };
    const keyOf = (ws: Awaited<ReturnType<typeof aiRow>>, provider: Provider) =>
      provider === 'openai' ? ws?.openaiKeyEnc : ws?.keyEnc;

    /** Both providers' settings; the last four characters of each key only for admins. */
    const aiSettings = async (workspaceId: string, admin: boolean) => {
      const ws = await aiRow(workspaceId);
      const hint = (enc: string | null | undefined) =>
        admin && enc ? `…${decryptSecret(config.appSecret, enc).slice(-4)}` : null;
      const provider: Provider = ws?.provider === 'openai' ? 'openai' : 'anthropic';
      const anthropic = {
        hasKey: Boolean(ws?.keyEnc),
        keyHint: hint(ws?.keyEnc),
        model: ws?.model ?? DEFAULT_ANTHROPIC_MODEL,
      };
      const openai = {
        hasKey: Boolean(ws?.openaiKeyEnc),
        keyHint: hint(ws?.openaiKeyEnc),
        model: ws?.openaiModel ?? null,
      };
      return {
        provider,
        providers: PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id] })),
        effort: ws?.effort ?? DEFAULT_EFFORT,
        efforts: EFFORTS,
        anthropic,
        openai,
        /** The chosen provider has a key and a model, so AI features work. */
        ready: provider === 'openai' ? openai.hasKey && Boolean(openai.model) : anthropic.hasKey,
      };
    };
    const isAdmin = (role: string) => role === 'owner' || role === 'admin';

    app.get('/settings/ai', async (req) => {
      const { workspace } = who(req);
      return aiSettings(workspace.id, isAdmin(workspace.role));
    });

    /** The provider's current models, live from its API with the saved key. */
    app.get('/settings/ai/models', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const { provider } = z.object({ provider: z.enum(PROVIDERS) }).parse(req.query);
      const enc = keyOf(await aiRow(workspace.id), provider);
      if (!enc) return reply.code(409).send({ error: 'Save a key first.' });
      try {
        const models = await modelsFor(
          `${workspace.id}:${provider}:${enc.slice(-24)}`,
          provider,
          decryptSecret(config.appSecret, enc),
        );
        return { models, suggested: suggestedModel(provider, models) ?? null };
      } catch (err) {
        return reply.code(502).send({ error: aiErrorText(err) });
      }
    });

    app.put('/settings/ai', async (req) => {
      const { workspace } = requireAdmin(req);
      const providerSettings = (key: z.ZodType<string>) =>
        z
          .object({
            /** A new key, or null to remove it; leave it out to keep the saved one. */
            apiKey: key.nullable().optional(),
            model: modelId.optional(),
          })
          .optional();
      const body = z
        .object({
          provider: z.enum(PROVIDERS).optional(),
          effort: z.enum(EFFORTS).optional(),
          anthropic: providerSettings(
            z
              .string()
              .trim()
              .regex(
                /^sk-ant-[\w-]{20,}$/,
                'That doesn’t look like an Anthropic API key (it starts with sk-ant-).',
              ),
          ),
          openai: providerSettings(
            z
              .string()
              .trim()
              .regex(
                /^sk-[\w-]{20,}$/,
                'That doesn’t look like an OpenAI API key (it starts with sk-).',
              ),
          ),
        })
        .parse(req.body);
      const enc = (k: string | null | undefined) =>
        k === undefined ? undefined : k ? encryptSecret(config.appSecret, k) : null;
      const anthropicKey = enc(body.anthropic?.apiKey);
      const openaiKey = enc(body.openai?.apiKey);
      let openaiModel = body.openai?.model;
      // A new OpenAI key with no model picked yet: start with a sensible one from its live list.
      if (body.openai?.apiKey && !openaiModel && !(await aiRow(workspace.id))?.openaiModel) {
        try {
          openaiModel = suggestedModel('openai', await listModels('openai', body.openai.apiKey));
        } catch {}
      }
      await db
        .update(workspaces)
        .set({
          ...(body.provider ? { aiProvider: body.provider } : {}),
          ...(body.effort ? { aiEffort: body.effort } : {}),
          ...(anthropicKey !== undefined ? { aiKeyEnc: anthropicKey } : {}),
          ...(body.anthropic?.model ? { aiModel: body.anthropic.model } : {}),
          ...(openaiKey !== undefined ? { aiOpenaiKeyEnc: openaiKey } : {}),
          ...(openaiModel ? { aiOpenaiModel: openaiModel } : {}),
        })
        .where(eq(workspaces.id, workspace.id));
      return aiSettings(workspace.id, true);
    });

    /** Checks a provider's saved key can use its model (a lookup, no tokens spent). */
    app.post('/settings/ai/test', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const ws = await aiRow(workspace.id);
      const { provider } = z
        .object({ provider: z.enum(PROVIDERS).optional() })
        .parse(req.body ?? {});
      const which: Provider = provider ?? (ws?.provider === 'openai' ? 'openai' : 'anthropic');
      const enc = keyOf(ws, which);
      const model = which === 'openai' ? ws?.openaiModel : (ws?.model ?? DEFAULT_ANTHROPIC_MODEL);
      if (!enc || !model)
        return reply.code(409).send({ error: 'Save a key and pick a model first.' });
      try {
        return {
          ok: true,
          model: await checkModel(which, decryptSecret(config.appSecret, enc), model),
        };
      } catch (err) {
        return reply.code(502).send({ error: aiErrorText(err) });
      }
    });

    /** A saved key, for the eye button (owners and admins). */
    app.post('/settings/ai/reveal', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const { provider } = z.object({ provider: z.enum(PROVIDERS) }).parse(req.body);
      const enc = keyOf(await aiRow(workspace.id), provider);
      if (!enc) return reply.code(404).send({ error: 'No key is saved.' });
      return { value: decryptSecret(config.appSecret, enc) };
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
          label: priceOf(r.model)?.label ?? r.model,
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
      // Triggers turned on or off, so their cards can say which.
      const triggerIds = new Set<string>();
      for (const m of messages)
        if (Array.isArray(m.content))
          for (const b of m.content) {
            const input = b.input as { triggerId?: unknown } | undefined;
            if (b.type === 'tool_use' && typeof input?.triggerId === 'string')
              triggerIds.add(input.triggerId);
          }
      const tids = [...triggerIds].filter((x) => z.uuid().safeParse(x).success);
      const triggerText = new Map(
        tids.length
          ? (
              await db
                .select({ id: triggers.id, config: triggers.config })
                .from(triggers)
                .where(and(inArray(triggers.id, tids), eq(triggers.workspaceId, t.workspaceId)))
            ).map((r) => [r.id, describeTrigger(r.config as Record<string, unknown>)])
          : [],
      );
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
        return fid && names.get(fid) ? `“${names.get(fid)}”` : 'an automation';
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
            /** A page the assistant opened beside the chat. */
            navigate?: string;
            /** The flow a change was made to, so an open builder can reload it. */
            flowId?: string;
          }
        | {
            type: 'ask';
            id: string;
            question: string;
            help?: string;
            kind: string;
            options: string[];
            placeholder?: string;
            step?: number;
            steps?: number;
            /** The plan, as short steps. */
            overview?: string[];
            state: 'waiting' | 'answered' | 'skipped';
            answer?: string;
          };
      const items: Item[] = [];
      const tools = new Map<string, Extract<Item, { type: 'tool' | 'ask' }>>();
      /** The latest plan an ask_user question carried; later questions show it too. */
      let plan: string[] | undefined;
      const pendingIds = new Set(t.pending?.calls.map((c) => c.id) ?? []);
      for (const m of messages) {
        const blocks: Block[] =
          typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        for (const b of blocks) {
          if (b.type === 'text' && b.text && !b.text.startsWith(CONTEXT))
            items.push({ type: m.role === 'user' ? 'user' : 'assistant', text: b.text });
          if (b.type === 'tool_use' && b.id && b.name === ASK_TOOL) {
            const input = (b.input ?? {}) as Record<string, unknown>;
            const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
            const int = (v: unknown) =>
              typeof v === 'number' && v > 0 ? Math.round(v) : undefined;
            if (Array.isArray(input.overview)) {
              const steps = input.overview
                .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
                .slice(0, 8)
                .map((o) => o.slice(0, 120));
              if (steps.length) plan = steps;
            }
            const item: Extract<Item, { type: 'ask' }> = {
              type: 'ask',
              id: b.id,
              question: str(input.question) ?? 'One question:',
              help: str(input.help),
              kind: str(input.kind) ?? 'text',
              options: Array.isArray(input.options)
                ? input.options.filter((o): o is string => typeof o === 'string').slice(0, 6)
                : [],
              placeholder: str(input.placeholder),
              step: int(input.step),
              steps: int(input.steps),
              overview: plan,
              state: 'waiting',
            };
            tools.set(b.id, item);
            items.push(item);
          } else if (b.type === 'tool_use' && b.id && b.name) {
            const input = (b.input ?? {}) as Record<string, unknown>;
            const changes = CHANGING_TOOLS.has(b.name);
            const graph = input.graph as { nodes: unknown[]; edges: unknown[] } | undefined;
            const label =
              b.name === 'create_flow'
                ? `Create the automation “${String(input.name)}”`
                : b.name === 'update_flow'
                  ? `Change ${flowName(input)}${input.name ? `, renamed “${String(input.name)}”` : ''}`
                  : b.name === 'add_trigger'
                    ? `Add a trigger to ${flowName(input)}`
                    : b.name === 'set_trigger_enabled'
                      ? `Turn a trigger ${input.enabled ? 'on' : 'off'}`
                      : b.name === 'publish_flow'
                        ? `Publish ${flowName(input)}`
                        : b.name === 'open_page'
                          ? `Opened ${pageName(String(input.path ?? ''))}`
                          : (READ_LABELS[b.name] ?? b.name);
            const detail =
              graph && Array.isArray(graph.nodes)
                ? describeGraph(graph)
                : b.name === 'add_trigger' && input.config
                  ? [describeTrigger(input.config as Record<string, unknown>)]
                  : b.name === 'publish_flow'
                    ? ['Its triggers start answering real people.']
                    : b.name === 'set_trigger_enabled' && triggerText.has(String(input.triggerId))
                      ? [String(triggerText.get(String(input.triggerId)))]
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
              ...(b.name === 'open_page' &&
              typeof input.path === 'string' &&
              PAGE_PATH.test(input.path)
                ? { navigate: input.path }
                : {}),
              ...(changes && typeof input.flowId === 'string' ? { flowId: input.flowId } : {}),
            };
            tools.set(b.id, item);
            items.push(item);
          }
          if (b.type === 'tool_result') {
            const r = b as unknown as ToolResultBlock;
            const item = tools.get(r.tool_use_id);
            if (!item) continue;
            const text = typeof r.content === 'string' ? r.content : '';
            if (item.type === 'ask') {
              if (text.startsWith(ANSWERED)) {
                item.state = 'answered';
                item.answer = text.slice(ANSWERED.length);
              } else item.state = 'skipped';
              continue;
            }
            if (text === DECLINED) item.state = 'declined';
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
        if (item?.type === 'tool') item.state = r.is_error ? 'failed' : 'done';
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
      if (t.status === 'waiting') {
        // Typing while it waits on a question answers the question.
        const asks = t.pending?.calls.filter((c) => c.name === ASK_TOOL) ?? [];
        if (!asks[0] || asks.length !== t.pending?.calls.length)
          return reply.code(409).send({ error: 'Approve or decline the proposed change first.' });
        await db
          .update(assistantThreads)
          .set({ status: 'working', updatedAt: new Date() })
          .where(eq(assistantThreads.id, id));
        const answers = { [asks[0].id]: body.text };
        start(req, id, (deps) => decide(deps, id, new Set(), answers));
        return reply.code(202).send(await view({ ...t, status: 'working' }));
      }
      const [ws] = await db
        .select({ name: workspaces.name, timeZone: workspaces.timeZone })
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      if (!ws || !(await workspaceAi(db, config.appSecret, workspace.id)))
        return reply.code(409).send({ error: 'Set up AI in Settings → AI first.' });
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

    /** Approve or decline the change(s) the assistant proposed, and answer its questions. */
    app.post('/assistant/threads/:id/decide', async (req, reply) => {
      const { user, workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { approve, answers } = z
        .object({
          approve: z.array(z.string()).max(20).default([]),
          answers: z.record(z.string(), z.string().max(4000)).default({}),
        })
        .parse(req.body);
      const t = await ownThread(user.id, workspace.id, id);
      if (t.status !== 'waiting' || !t.pending || running.has(id))
        return reply.code(409).send({ error: 'Nothing is waiting for a decision.' });
      await db
        .update(assistantThreads)
        .set({ status: 'working', updatedAt: new Date() })
        .where(eq(assistantThreads.id, id));
      start(req, id, (deps) => decide(deps, id, new Set(approve), answers));
      return reply.code(202).send(await view({ ...t, status: 'working' }));
    });
  };
