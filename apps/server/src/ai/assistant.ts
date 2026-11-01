import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { decryptSecret } from '../crypto';
import type { Db } from '../db/client';
import {
  type AssistantPending,
  aiActions,
  aiUsage,
  assistantThreads,
  workspaces,
} from '../db/schema';
import { DEFAULT_EFFORT, EFFORTS, type Effort, modelFor } from './models';
import { SYSTEM_PROMPT } from './prompt';

// The in-app assistant: a Claude tool loop over the app's own API. Reading tools run right away;
// changing tools wait for the person to approve them (the loop stops, the thread is saved, and
// it carries on from their decision). The conversation is append-only, as the API requires.

type Message = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** Calls this install's own API as the signed-in person (their permissions apply). */
export type ApiCall = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: object,
) => Promise<{ status: number; body: unknown }>;

export type AssistantDeps = {
  db: Db;
  appSecret: string;
  api: ApiCall;
  workspaceId: string;
  userId: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
};

type Client = Pick<Anthropic, 'beta'>;
let makeClient = (apiKey: string): Client => new Anthropic({ apiKey, timeout: 180_000 });
/** Swappable for tests. */
export function setAssistantClient(factory: (apiKey: string) => Client) {
  makeClient = factory;
}

const MAX_STEPS = 12;
const anyObject = { type: 'object' as const, properties: {} };
const graphSchema = {
  type: 'object',
  description: 'The whole flow: {"nodes":[...],"edges":[...]} in the format from the instructions.',
  properties: {
    nodes: { type: 'array', items: { type: 'object' } },
    edges: { type: 'array', items: { type: 'object' } },
  },
  required: ['nodes', 'edges'],
};
const id = (description: string) => ({ type: 'string', description });

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_overview',
    description:
      'What is set up: connected Instagram accounts and their problems, webhooks, whether DMs are going out, the last event from Instagram, and counts of flows, contacts and conversations.',
    input_schema: anyObject,
  },
  {
    name: 'list_flows',
    description:
      'All flows: id, name, whether published (and unpublished changes), trigger and run counts.',
    input_schema: anyObject,
  },
  {
    name: 'get_flow',
    description:
      "One flow's draft graph, its triggers (with ids), its wiring problems, and its published version.",
    input_schema: {
      type: 'object',
      properties: { flowId: id('The flow id') },
      required: ['flowId'],
    },
  },
  {
    name: 'list_posts',
    description:
      'Recent Instagram posts (id, caption, kind, date, link), newest first, for comment triggers on specific posts.',
    input_schema: anyObject,
  },
  {
    name: 'find_contacts',
    description:
      'Search contacts by name, email, phone or @username. Empty query lists recent ones.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_contact_history',
    description:
      "A contact's recent conversation (what they sent, what was sent or refused and why), their flow runs and errors, tags, fields and whether the bot is paused for them.",
    input_schema: {
      type: 'object',
      properties: { contactId: id('The contact id') },
      required: ['contactId'],
    },
  },
  {
    name: 'get_setup_guide',
    description:
      'The step-by-step guide for connecting Instagram (Meta app, login, webhooks, permissions).',
    input_schema: anyObject,
  },
  {
    name: 'check_file_link',
    description:
      'Whether Instagram will send a link as a document (a direct PDF up to 25 MB) or as a button.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'create_flow',
    description:
      'Proposes a new flow (saved as a draft, not published). The person approves it first. Returns the new flow id and any wiring problems.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, graph: graphSchema },
      required: ['name', 'graph'],
    },
  },
  {
    name: 'update_flow',
    description:
      "Proposes replacing a flow's draft with a new graph (and optionally renaming it). Send the whole graph; keep existing steps' positions. The person approves it first.",
    input_schema: {
      type: 'object',
      properties: { flowId: id('The flow id'), name: { type: 'string' }, graph: graphSchema },
      required: ['flowId', 'graph'],
    },
  },
  {
    name: 'add_trigger',
    description: 'Proposes adding a trigger to a flow. The person approves it first.',
    input_schema: {
      type: 'object',
      properties: {
        flowId: id('The flow id'),
        config: { type: 'object', description: 'The trigger, as in the instructions.' },
      },
      required: ['flowId', 'config'],
    },
  },
  {
    name: 'set_trigger_enabled',
    description: 'Proposes turning a trigger on or off. The person approves it first.',
    input_schema: {
      type: 'object',
      properties: { triggerId: id('The trigger id'), enabled: { type: 'boolean' } },
      required: ['triggerId', 'enabled'],
    },
  },
  {
    name: 'publish_flow',
    description:
      'Proposes publishing a flow, so its triggers start answering real people. The person approves it first.',
    input_schema: {
      type: 'object',
      properties: { flowId: id('The flow id') },
      required: ['flowId'],
    },
  },
];

export const CHANGING_TOOLS = new Set([
  'create_flow',
  'update_flow',
  'add_trigger',
  'set_trigger_enabled',
  'publish_flow',
]);

// ---------------------------------------------------------------- tool inputs

const inputs = {
  get_flow: z.object({ flowId: z.string().min(1) }),
  find_contacts: z.object({ query: z.string().max(200) }),
  get_contact_history: z.object({ contactId: z.string().min(1) }),
  check_file_link: z.object({ url: z.string().min(1).max(2000) }),
  create_flow: z.object({
    name: z.string().trim().min(1).max(100),
    graph: z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }),
  }),
  update_flow: z.object({
    flowId: z.string().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    graph: z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }),
  }),
  add_trigger: z.object({ flowId: z.string().min(1), config: z.record(z.string(), z.unknown()) }),
  set_trigger_enabled: z.object({ triggerId: z.string().min(1), enabled: z.boolean() }),
  publish_flow: z.object({ flowId: z.string().min(1) }),
};

type Node = { id?: unknown; type?: unknown; data?: Record<string, unknown>; position?: unknown };
type Edge = { id?: unknown; source?: unknown; sourceHandle?: unknown; target?: unknown };

/**
 * Fills in what the assistant may leave out: edge ids, and positions for new steps (laid out
 * left to right by distance from the start; existing steps keep theirs).
 */
export function layOut(graph: { nodes: unknown[]; edges: unknown[] }) {
  const nodes = graph.nodes.map((n) => ({ ...(n as Node) }));
  const edges = graph.edges.map((e, i) => {
    const edge = e as Edge;
    return {
      ...edge,
      id:
        edge.id ??
        `${String(edge.source)}-${String(edge.sourceHandle)}-${String(edge.target)}-${i}`,
    };
  });
  const depth = new Map<unknown, number>();
  const start = nodes.find((n) => n.type === 'start');
  const queue: unknown[] = start ? [start.id] : [];
  if (start) depth.set(start.id, 0);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const e of edges)
      if (e.source === current && !depth.has(e.target)) {
        depth.set(e.target, (depth.get(current) ?? 0) + 1);
        queue.push(e.target);
      }
  }
  const rows = new Map<number, number>();
  const placed = (p: unknown) =>
    typeof p === 'object' && p !== null && 'x' in p && 'y' in p ? p : undefined;
  for (const n of nodes) {
    if (placed(n.position)) continue;
    const d = depth.get(n.id) ?? Math.max(0, ...depth.values()) + 1;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    n.position = { x: d * 320, y: row * 220 };
  }
  return { nodes, edges };
}

const short = (s: unknown, n = 80) => {
  const text = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/** One line per step, for the approval card. */
export function describeGraph(graph: { nodes: unknown[]; edges: unknown[] }): string[] {
  return graph.nodes.map((raw) => {
    const n = raw as Node;
    const d = n.data ?? {};
    switch (n.type) {
      case 'start':
        return 'Start';
      case 'message': {
        const parts = (d.parts as { type: string; text?: string; name?: string }[]) ?? [];
        const text = parts.map((p) =>
          p.type === 'text' ? p.text : p.type === 'file' ? `📄 ${p.name}` : '🖼 image',
        );
        const choices = [
          ...((d.buttons as { label: string }[]) ?? []).map((b) => `[${b.label}]`),
          ...((d.quickReplies as { label: string }[]) ?? []).map((q) => `(${q.label})`),
        ];
        return `Message: ${short(text.join(' · '))}${choices.length ? ` ${choices.join(' ')}` : ''}`;
      }
      case 'ask':
        return `Ask (${String(d.inputType)}): ${short(d.question)}`;
      case 'condition':
        return `Check: ${((d.cases as unknown[]) ?? []).length} case(s), else`;
      case 'action':
        return `Do: ${(
          (d.actions as { type: string; tag?: string; key?: string; message?: string }[]) ?? []
        )
          .map(
            (a) =>
              `${a.type.replace('_', ' ')}${a.tag ? ` “${a.tag}”` : a.key ? ` ${a.key}` : a.message ? ` “${short(a.message, 40)}”` : ''}`,
          )
          .join(', ')}`;
      case 'delay':
        return d.mode === 'duration'
          ? `Wait ${String(d.amount)} ${String(d.unit)}`
          : `Wait until ${String(d.time)}`;
      case 'split':
        return `Split: ${((d.branches as { label: string; weight: number }[]) ?? []).map((b) => `${b.label} ${b.weight}%`).join(' / ')}`;
      case 'goto_flow':
        return 'Go to another flow';
      case 'handoff':
        return `Hand off to a person${d.note ? `: ${short(d.note, 50)}` : ''}`;
      default:
        return String(n.type);
    }
  });
}

/** A trigger config in words, for the approval card. */
export function describeTrigger(c: Record<string, unknown>): string {
  const words = (c.keywords as string[] | undefined)?.length
    ? `“${(c.keywords as string[]).join('”, “')}”`
    : 'any message';
  switch (c.type) {
    case 'comment': {
      const posts = (c.mediaIds as string[] | undefined)?.length ?? 0;
      return `When someone comments ${words === 'any message' ? 'anything' : words} on ${posts ? `${posts} post${posts === 1 ? '' : 's'}` : 'any post'}`;
    }
    case 'keyword':
      return `When someone DMs ${words}`;
    case 'welcome':
      return 'When a new contact messages for the first time';
    case 'default_reply':
      return 'When a DM matches nothing else';
    case 'ref':
      return `When someone opens a link with ref=${String(c.ref)}`;
    default:
      return String(c.type);
  }
}

// ---------------------------------------------------------------- running tools

const failed = (r: { status: number; body: unknown }) => {
  const b = r.body as { error?: string; issues?: { path: unknown[]; message: string }[] } | null;
  const issues = b?.issues?.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`);
  return `The app refused this (${r.status}): ${b?.error ?? 'error'}${issues?.length ? `\n${issues.join('\n')}` : ''}`;
};

/** Runs one tool through the API. Returns the text for Claude and a one-line summary for the log. */
async function runTool(
  api: ApiCall,
  name: string,
  raw: unknown,
): Promise<{ content: string; ok: boolean; summary: string }> {
  const ok = (data: unknown, summary: string) => ({
    content: JSON.stringify(data),
    ok: true,
    summary,
  });
  const err = (content: string) => ({
    content,
    ok: false,
    summary: content.split('\n')[0] ?? content,
  });
  const parse = <T>(schema: z.ZodType<T>) => {
    const p = schema.safeParse(raw ?? {});
    return p.success ? p.data : undefined;
  };
  const badInput = err(
    'The tool input was missing something or malformed. Check the fields and try again.',
  );

  switch (name) {
    case 'get_overview': {
      const [overview, ig, inbox] = await Promise.all([
        api('GET', '/api/overview'),
        api('GET', '/api/instagram/settings'),
        api('GET', '/api/inbox?view=all&limit=1'),
      ]);
      const s = ig.body as Record<string, unknown> & { accounts?: Record<string, unknown>[] };
      return ok(
        {
          counts: overview.body,
          conversations: (inbox.body as { counts?: unknown }).counts,
          instagram: {
            login: s.loginMode ?? 'not set up',
            metaAppSecretSaved: s.hasFacebookAppSecret,
            webhooksVerifiedAt: s.webhookVerifiedAt,
            lastEventFromInstagramAt: s.lastWebhookAt,
            lastDmAcceptedAt: s.lastSentAt,
            waitingForAccountId: s.accountIdNeeded,
            accounts: (s.accounts ?? []).map((a) => ({
              username: a.username,
              status: a.status,
              problem: a.statusDetail,
              connectedAt: a.connectedAt,
            })),
          },
        },
        'Checked the setup',
      );
    }
    case 'list_flows': {
      const r = await api('GET', '/api/flows');
      return r.status === 200 ? ok(r.body, 'Looked at the flows') : err(failed(r));
    }
    case 'get_flow': {
      const input = parse(inputs.get_flow);
      if (!input) return badInput;
      const r = await api('GET', `/api/flows/${encodeURIComponent(input.flowId)}`);
      if (r.status !== 200) return err(failed(r));
      const b = r.body as {
        flow: { id: string; name: string; draft: unknown; publishedVersionId: string | null };
        issues: unknown;
        triggers: { id: string; enabled: boolean; config: unknown }[];
        versions: { number: number }[];
      };
      return ok(
        {
          id: b.flow.id,
          name: b.flow.name,
          published: b.versions[0] ? `version ${b.versions[0].number}` : 'never published',
          draft: b.flow.draft,
          wiringProblems: b.issues,
          triggers: b.triggers.map((t) => ({ id: t.id, enabled: t.enabled, config: t.config })),
        },
        `Opened “${b.flow.name}”`,
      );
    }
    case 'list_posts': {
      const r = await api('GET', '/api/instagram/media');
      if (r.status !== 200) return err(failed(r));
      const media = (r.body as { media: Record<string, unknown>[] }).media.map((m) => ({
        id: m.id,
        caption: short(m.caption, 120),
        kind: m.kind,
        date: m.timestamp,
        link: m.permalink,
      }));
      return ok(media, 'Looked at the posts');
    }
    case 'find_contacts': {
      const input = parse(inputs.find_contacts);
      if (!input) return badInput;
      const r = await api(
        'GET',
        `/api/contacts?${new URLSearchParams({ q: input.query, limit: '20' })}`,
      );
      if (r.status !== 200) return err(failed(r));
      const contacts = (r.body as { contacts: Record<string, unknown>[] }).contacts.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
        username: c.username,
        email: c.email,
        tags: c.tags,
        channels: c.channels,
        botPaused: Boolean(c.automationPausedAt),
        lastSeenAt: c.lastSeenAt,
      }));
      return ok(
        contacts,
        input.query
          ? `Searched contacts for “${short(input.query, 30)}”`
          : 'Looked at recent contacts',
      );
    }
    case 'get_contact_history': {
      const input = parse(inputs.get_contact_history);
      if (!input) return badInput;
      const [contact, thread] = await Promise.all([
        api('GET', `/api/contacts/${encodeURIComponent(input.contactId)}`),
        api('GET', `/api/inbox/${encodeURIComponent(input.contactId)}`),
      ]);
      if (contact.status !== 200) return err(failed(contact));
      const c = contact.body as Record<string, unknown> & {
        contact: Record<string, unknown>;
        runs: unknown[];
      };
      const t =
        thread.status === 200
          ? (thread.body as { messages: Record<string, unknown>[] })
          : undefined;
      return ok(
        {
          contact: c.contact,
          identities: c.identities,
          recentEvents: (c.events as unknown[] | undefined)?.slice(0, 20),
          flowRuns: c.runs,
          conversation: t?.messages.slice(-40).map((m) => ({
            at: m.at,
            from: m.by,
            status: m.status,
            error: m.error,
            content: m.content,
          })),
        },
        'Read a conversation',
      );
    }
    case 'get_setup_guide': {
      const r = await api('GET', '/api/guides/connect-instagram');
      return r.status === 200
        ? {
            content: String((r.body as { markdown: string }).markdown),
            ok: true,
            summary: 'Read the setup guide',
          }
        : err(failed(r));
    }
    case 'check_file_link': {
      const input = parse(inputs.check_file_link);
      if (!input) return badInput;
      const r = await api('POST', '/api/instagram/check-file', { url: input.url });
      return r.status === 200 ? ok(r.body, 'Checked a file link') : err(failed(r));
    }
    case 'create_flow': {
      const input = parse(inputs.create_flow);
      if (!input) return badInput;
      const made = await api('POST', '/api/flows', { name: input.name, starter: 'blank' });
      if (made.status >= 300) return err(failed(made));
      const flowId = (made.body as { flow: { id: string } }).flow.id;
      const saved = await api('PUT', `/api/flows/${flowId}/draft`, { graph: layOut(input.graph) });
      if (saved.status >= 300)
        return err(
          `The flow “${input.name}” was created (id ${flowId}) but its steps were refused. ${failed(saved)}\nFix the graph and use update_flow on this id.`,
        );
      return ok(
        { flowId, wiringProblems: (saved.body as { issues: unknown }).issues, published: false },
        `Created the flow “${input.name}” (draft)`,
      );
    }
    case 'update_flow': {
      const input = parse(inputs.update_flow);
      if (!input) return badInput;
      const saved = await api('PUT', `/api/flows/${encodeURIComponent(input.flowId)}/draft`, {
        graph: layOut(input.graph),
      });
      if (saved.status >= 300) return err(failed(saved));
      if (input.name) {
        const renamed = await api('PATCH', `/api/flows/${encodeURIComponent(input.flowId)}`, {
          name: input.name,
        });
        if (renamed.status >= 300) return err(failed(renamed));
      }
      return ok(
        { wiringProblems: (saved.body as { issues: unknown }).issues, published: false },
        'Changed the flow’s draft',
      );
    }
    case 'add_trigger': {
      const input = parse(inputs.add_trigger);
      if (!input) return badInput;
      const r = await api('POST', '/api/triggers', { flowId: input.flowId, config: input.config });
      return r.status < 300
        ? ok(
            { triggerId: (r.body as { trigger: { id: string } }).trigger.id },
            `Added a trigger: ${describeTrigger(input.config)}`,
          )
        : err(failed(r));
    }
    case 'set_trigger_enabled': {
      const input = parse(inputs.set_trigger_enabled);
      if (!input) return badInput;
      const r = await api('PATCH', `/api/triggers/${encodeURIComponent(input.triggerId)}`, {
        enabled: input.enabled,
      });
      return r.status < 300
        ? ok({ enabled: input.enabled }, `Turned a trigger ${input.enabled ? 'on' : 'off'}`)
        : err(failed(r));
    }
    case 'publish_flow': {
      const input = parse(inputs.publish_flow);
      if (!input) return badInput;
      const r = await api('POST', `/api/flows/${encodeURIComponent(input.flowId)}/publish`, {});
      return r.status < 300 ? ok(r.body, 'Published the flow') : err(failed(r));
    }
    default:
      return err(`There's no tool called ${name}.`);
  }
}

// ---------------------------------------------------------------- the loop

async function settings(db: Db, appSecret: string, workspaceId: string) {
  const [ws] = await db
    .select({ model: workspaces.aiModel, effort: workspaces.aiEffort, keyEnc: workspaces.aiKeyEnc })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws?.keyEnc) return undefined;
  return {
    apiKey: decryptSecret(appSecret, ws.keyEnc),
    model: modelFor(ws.model),
    effort: (EFFORTS as readonly string[]).includes(ws.effort ?? '')
      ? (ws.effort as Effort)
      : DEFAULT_EFFORT,
  };
}

async function save(
  db: Db,
  threadId: string,
  fields: Partial<typeof assistantThreads.$inferInsert>,
) {
  await db
    .update(assistantThreads)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(assistantThreads.id, threadId));
}

async function log(
  deps: AssistantDeps,
  threadId: string,
  tool: string,
  input: unknown,
  decision: 'auto' | 'approved' | 'declined',
  result: { ok: boolean; summary: string },
) {
  await deps.db.insert(aiActions).values({
    workspaceId: deps.workspaceId,
    threadId,
    userId: deps.userId,
    tool,
    input: input as object,
    decision,
    ok: result.ok,
    summary: result.summary.slice(0, 500),
  });
}

/** Plain words for an API failure, shown in the assistant panel. */
function friendly(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError)
    return 'The Anthropic API key was refused. Check it in Settings → AI.';
  if (err instanceof Anthropic.PermissionDeniedError)
    return 'That Anthropic key can’t use this model. Pick another model in Settings → AI.';
  if (err instanceof Anthropic.RateLimitError)
    return 'Anthropic says you’ve hit a rate limit. Wait a minute and try again.';
  if (err instanceof Anthropic.BadRequestError)
    return `Anthropic refused the request: ${err.message}`;
  if (err instanceof Anthropic.APIError)
    return `Anthropic had a problem (${err.status ?? 'no answer'}). Try again in a moment.`;
  return 'Something went wrong talking to the AI. Try again in a moment.';
}

/**
 * Runs the conversation forward from where it is: calls Claude, runs reading tools, and stops
 * when Claude is done or proposes a change (status "waiting").
 */
export async function advance(deps: AssistantDeps, threadId: string) {
  const [thread] = await deps.db
    .select()
    .from(assistantThreads)
    .where(eq(assistantThreads.id, threadId));
  if (!thread) return;
  const s = await settings(deps.db, deps.appSecret, deps.workspaceId);
  if (!s) {
    await save(deps.db, threadId, {
      status: 'error',
      error: 'Add an Anthropic API key in Settings → AI first.',
    });
    return;
  }
  const client = makeClient(s.apiKey);
  const messages = thread.messages as Message[];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model: s.model.id,
        max_tokens: 16000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
        output_config: { effort: s.effort },
        // Caches the growing conversation too, so each step only pays for what's new.
        cache_control: { type: 'ephemeral' },
        // A declined request is retried on a suitable model by the API itself (not on Haiku).
        ...(s.model.fallbacks
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      });
      await deps.db.insert(aiUsage).values({
        workspaceId: deps.workspaceId,
        userId: deps.userId,
        threadId,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      });
      // The whole content goes back as-is (thinking and fallback blocks included).
      messages.push({ role: 'assistant', content: response.content });
      await save(deps.db, threadId, { messages });

      if (response.stop_reason === 'refusal') {
        await save(deps.db, threadId, {
          status: 'error',
          error: 'Claude declined to help with that. Try asking differently.',
        });
        return;
      }
      if (response.stop_reason === 'pause_turn') continue;
      const uses = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      if (uses.length === 0) break;
      if (response.stop_reason === 'max_tokens') {
        // A cut-off tool call may parse as a partial input: never run it.
        messages.push({
          role: 'user',
          content: uses.map((u) => ({
            type: 'tool_result' as const,
            tool_use_id: u.id,
            is_error: true,
            content:
              'Your message was cut off before this finished. Make the change in smaller pieces.',
          })),
        });
        continue;
      }

      const reading = uses.filter((u) => !CHANGING_TOOLS.has(u.name));
      const changing = uses.filter((u) => CHANGING_TOOLS.has(u.name));
      const results: ToolResult[] = await Promise.all(
        reading.map(async (u) => {
          const r = await runTool(deps.api, u.name, u.input);
          await log(deps, threadId, u.name, u.input, 'auto', r);
          return {
            type: 'tool_result' as const,
            tool_use_id: u.id,
            content: r.content,
            is_error: !r.ok,
          };
        }),
      );
      if (changing.length > 0) {
        const pending: AssistantPending = {
          calls: changing.map((u) => ({ id: u.id, name: u.name, input: u.input })),
          results: results.map((r) => ({
            tool_use_id: r.tool_use_id,
            content: String(r.content),
            is_error: r.is_error,
          })),
        };
        await save(deps.db, threadId, { messages, pending, status: 'waiting', error: null });
        return;
      }
      messages.push({ role: 'user', content: results });
      await save(deps.db, threadId, { messages });
    }
    await save(deps.db, threadId, { messages, status: 'idle', error: null });
  } catch (err) {
    deps.log?.('assistant failed', { error: err instanceof Error ? err.message : String(err) });
    await save(deps.db, threadId, { messages, status: 'error', error: friendly(err) });
  }
}

/** The person approved or declined the proposed changes: apply the approved ones, carry on. */
export async function decide(deps: AssistantDeps, threadId: string, approved: Set<string>) {
  const [thread] = await deps.db
    .select()
    .from(assistantThreads)
    .where(eq(assistantThreads.id, threadId));
  if (!thread?.pending) return;
  const results: ToolResult[] = thread.pending.results.map((r) => ({
    type: 'tool_result',
    tool_use_id: r.tool_use_id,
    content: r.content,
    is_error: r.is_error,
  }));
  for (const call of thread.pending.calls) {
    if (approved.has(call.id)) {
      const r = await runTool(deps.api, call.name, call.input);
      await log(deps, threadId, call.name, call.input, 'approved', r);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: r.content,
        is_error: !r.ok,
      });
    } else {
      await log(deps, threadId, call.name, call.input, 'declined', {
        ok: true,
        summary: 'Declined',
      });
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content:
          'The person declined this change, so nothing was saved. Ask what they’d like instead.',
      });
    }
  }
  const messages = [...(thread.messages as Message[]), { role: 'user' as const, content: results }];
  await save(deps.db, threadId, { messages, pending: null, status: 'working', error: null });
  await advance(deps, threadId);
}
