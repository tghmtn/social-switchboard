import type { FlowGraph, NodeOf } from '@social-switchboard/flow';
import { and, asc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { contacts, flowVersions, messages, runs } from '../db/schema';
import type { AiRoute, AiTurn, AiTurnResult } from '../runtime/runtime';
import { aiClient, recordUsage, workspaceAi } from './client';

// The AI steps in flows. A turn of an AI conversation: given the step's goal and the
// conversation so far, Claude writes the next reply, picks out the fields the step collects, and
// says whether the goal is met, a person should take over, or the conversation goes on. An AI
// sort: Claude says which of the step's intents their latest message is about. The runtime feeds
// each answer back to the engine.

const SYSTEM = `You run one step of an automated Instagram DM conversation for a small business or creator. The business set a goal for this step and may have given you facts, tone and rules; follow them. Each turn, write the next message to send them, pick out any of the requested details they've given, and decide how the step stands:
- "continue": you sent a message and need their answer.
- "done": the goal is met (your reply can be a short wrap-up, or empty).
- "handoff": they want a person, are upset, or ask something you can't answer from what you were given. Your reply can tell them someone will follow up.
Write like a person texting: short (one to three sentences), warm, in their language. Ask one thing at a time. Only use facts from the business's notes and the conversation; never invent prices, dates, links or promises. Field values must be exactly what they said, cleaned up (an email address, a name), never guessed.`;

const ROUTE_SYSTEM = `You sort incoming Instagram messages and comments for a small business or creator. Given the business's categories and the conversation, pick the one category the person's latest message is about, or "none" when no category fits. Judge by meaning, not exact words, in any language. If it fits several, pick what it mainly asks for; the earlier conversation is only there to make the latest message clear.`;

const answer = z.object({
  reply: z.string().max(2000),
  fields: z.array(z.object({ key: z.string(), value: z.string().max(500) })).max(20),
  outcome: z.enum(['continue', 'done', 'handoff']),
});

type Deps = {
  db: Db;
  appSecret: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
};
type WorkspaceAi = NonNullable<Awaited<ReturnType<typeof workspaceAi>>>;

/** One line of a message, for the transcript. */
function line(direction: string, content: unknown) {
  const c = content as {
    text?: string;
    comment?: unknown;
    message?: { parts?: { type: string; text?: string; name?: string }[] };
  };
  if (direction === 'in')
    return `Them${c.comment ? ' (commenting on a post)' : ''}: ${c.text ?? '(a photo or attachment)'}`;
  const parts = c.message?.parts ?? [];
  return `You: ${parts.map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `[file: ${p.name}]` : '[image]')).join(' ')}`;
}

/** The run's step (if it is still of that type in the version it runs) and when the run began. */
async function stepOf<T extends 'ai' | 'ai_route'>(db: Db, runId: string, nodeId: string, type: T) {
  const [run] = await db
    .select({ versionId: runs.flowVersionId, startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!run) return undefined;
  const [version] = await db
    .select({ graph: flowVersions.graph })
    .from(flowVersions)
    .where(eq(flowVersions.id, run.versionId));
  const node = (version?.graph as FlowGraph | undefined)?.nodes.find(
    (n): n is NodeOf<T> => n.id === nodeId && n.type === type,
  );
  return node && { node, startedAt: run.startedAt };
}

/**
 * The conversation since the run started (plus a few minutes before, for the comment or message
 * that started it), oldest first, without messages that never went out.
 */
async function conversation(db: Db, contactId: string, startedAt: Date) {
  const rows = await db
    .select({ direction: messages.direction, content: messages.content, status: messages.status })
    .from(messages)
    .where(
      and(
        eq(messages.contactId, contactId),
        gte(messages.createdAt, new Date(startedAt.getTime() - 10 * 60_000)),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(60);
  return rows.filter((m) => m.status !== 'failed' && m.status !== 'blocked');
}

/** One structured answer from the workspace's model; undefined if it refused or broke format. */
async function askFor(
  db: Db,
  workspaceId: string,
  ai: WorkspaceAi,
  request: { system: string; brief: string; schema: Record<string, unknown>; maxTokens: number },
): Promise<unknown> {
  const response = await aiClient(ai.apiKey).beta.messages.create(
    {
      model: ai.model.id,
      max_tokens: request.maxTokens,
      system: request.system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: request.schema } },
      ...(ai.model.fallbacks
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
      messages: [{ role: 'user', content: request.brief }],
    },
    // The webhook pass that started this holds its event for two minutes: answer well before.
    { timeout: 45_000, maxRetries: 1 },
  );
  await recordUsage(db, { workspaceId }, response);
  if (response.stop_reason === 'refusal') return undefined;
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function aiStepper(deps: Deps) {
  return async (t: AiTurn): Promise<AiTurnResult> => {
    const { db } = deps;
    const ai = await workspaceAi(db, deps.appSecret, t.workspaceId);
    if (!ai) {
      deps.log?.('AI step without an AI key: handing off', { runId: t.runId });
      return { outcome: 'handoff' };
    }
    const found = await stepOf(db, t.runId, t.nodeId, 'ai');
    if (!found) return { outcome: 'handoff' };
    const { node } = found;

    const [contact] = await db.select().from(contacts).where(eq(contacts.id, t.contactId));
    const known: Record<string, unknown> = {
      first_name: contact?.firstName,
      last_name: contact?.lastName,
      email: contact?.email,
      phone: contact?.phone,
      ...contact?.customFields,
    };
    const transcript = (await conversation(db, t.contactId, found.startedAt))
      .map((m) => line(m.direction, m.content))
      .join('\n');
    const keys = node.data.collect.map((c) => c.key);
    const brief = [
      `Goal: ${node.data.goal}`,
      node.data.instructions && `Notes from the business:\n${node.data.instructions}`,
      keys.length
        ? `Details to collect (key: what it is; current value):\n${node.data.collect
            .map(
              (c) =>
                `- ${c.key}: ${c.description || c.key.replace(/_/g, ' ')}; ${known[c.key] ? `already have “${String(known[c.key])}”` : 'not yet'}`,
            )
            .join('\n')}`
        : '',
      known.first_name ? `Their first name: ${String(known.first_name)}` : '',
      `Your messages so far in this step: ${t.turns} of at most ${node.data.maxTurns}.`,
      `The conversation, oldest first:\n${transcript || '(nothing yet: start it)'}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const parsed = answer.safeParse(
      await askFor(db, t.workspaceId, ai, {
        system: SYSTEM,
        brief,
        maxTokens: 4000,
        schema: {
          type: 'object',
          properties: {
            reply: { type: 'string' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: keys.length ? { type: 'string', enum: keys } : { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['key', 'value'],
                additionalProperties: false,
              },
            },
            outcome: { type: 'string', enum: ['continue', 'done', 'handoff'] },
          },
          required: ['reply', 'fields', 'outcome'],
          additionalProperties: false,
        },
      }),
    );
    if (!parsed.success) {
      deps.log?.('AI step gave no usable answer: handing off', { runId: t.runId });
      return { outcome: 'handoff' };
    }
    return {
      reply: parsed.data.reply,
      fields: Object.fromEntries(
        parsed.data.fields.filter((f) => keys.includes(f.key)).map((f) => [f.key, f.value]),
      ),
      outcome: parsed.data.outcome,
    };
  };
}

export function aiRouter(deps: Deps) {
  return async (t: AiRoute): Promise<{ intent?: string }> => {
    const { db } = deps;
    const ai = await workspaceAi(db, deps.appSecret, t.workspaceId);
    if (!ai) {
      deps.log?.('AI sort without an AI key: no match', { runId: t.runId });
      return {};
    }
    const found = await stepOf(db, t.runId, t.nodeId, 'ai_route');
    if (!found) return {};
    const rows = await conversation(db, t.contactId, found.startedAt);
    const latest = rows.findLast((m) => m.direction === 'in');
    // Nothing they wrote to sort (a link or a button started this): no match.
    if (!latest) return {};

    const ids = found.node.data.intents.map((i) => i.id);
    const brief = [
      `Categories (id: name, what it looks like):\n${found.node.data.intents
        .map((i) => `- ${i.id}: ${i.label}${i.description ? `, ${i.description}` : ''}`)
        .join('\n')}`,
      `The conversation, oldest first:\n${rows
        .slice(-10)
        .map((m) => line(m.direction, m.content))
        .join('\n')}`,
      `Their latest message: ${line('in', latest.content).replace(/^Them[^:]*: /, '')}`,
    ].join('\n\n');
    const picked = z.object({ intent: z.string() }).safeParse(
      await askFor(db, t.workspaceId, ai, {
        system: ROUTE_SYSTEM,
        brief,
        maxTokens: 2000,
        schema: {
          type: 'object',
          properties: { intent: { type: 'string', enum: [...ids, 'none'] } },
          required: ['intent'],
          additionalProperties: false,
        },
      }),
    );
    const intent = picked.success ? picked.data.intent : undefined;
    return intent && ids.includes(intent) ? { intent } : {};
  };
}
