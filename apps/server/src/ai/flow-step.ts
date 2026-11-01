import type { FlowGraph, NodeOf } from '@social-switchboard/flow';
import { and, asc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { contacts, flowVersions, messages, runs } from '../db/schema';
import type { AiTurn, AiTurnResult } from '../runtime/runtime';
import { aiClient, recordUsage, workspaceAi } from './client';

// The AI step's turn: given the step's goal and the conversation so far, Claude writes the next
// reply, picks out the fields the step collects, and says whether the goal is met, a person
// should take over, or the conversation goes on. The runtime feeds the answer back to the engine.

const SYSTEM = `You run one step of an automated Instagram DM conversation for a small business or creator. The business set a goal for this step and may have given you facts, tone and rules; follow them. Each turn, write the next message to send them, pick out any of the requested details they've given, and decide how the step stands:
- "continue": you sent a message and need their answer.
- "done": the goal is met (your reply can be a short wrap-up, or empty).
- "handoff": they want a person, are upset, or ask something you can't answer from what you were given. Your reply can tell them someone will follow up.
Write like a person texting: short (one to three sentences), warm, in their language. Ask one thing at a time. Only use facts from the business's notes and the conversation; never invent prices, dates, links or promises. Field values must be exactly what they said, cleaned up (an email address, a name), never guessed.`;

const answer = z.object({
  reply: z.string().max(2000),
  fields: z.array(z.object({ key: z.string(), value: z.string().max(500) })).max(20),
  outcome: z.enum(['continue', 'done', 'handoff']),
});

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

export function aiStepper(deps: {
  db: Db;
  appSecret: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}) {
  return async (t: AiTurn): Promise<AiTurnResult> => {
    const { db } = deps;
    const ai = await workspaceAi(db, deps.appSecret, t.workspaceId);
    if (!ai) {
      deps.log?.('AI step without an AI key: handing off', { runId: t.runId });
      return { outcome: 'handoff' };
    }
    const [run] = await db
      .select({ versionId: runs.flowVersionId, startedAt: runs.startedAt })
      .from(runs)
      .where(eq(runs.id, t.runId));
    if (!run) return { outcome: 'handoff' };
    const [version] = await db
      .select({ graph: flowVersions.graph })
      .from(flowVersions)
      .where(eq(flowVersions.id, run.versionId));
    const node = (version?.graph as FlowGraph | undefined)?.nodes.find(
      (n): n is NodeOf<'ai'> => n.id === t.nodeId && n.type === 'ai',
    );
    if (!node) return { outcome: 'handoff' };

    const [contact] = await db.select().from(contacts).where(eq(contacts.id, t.contactId));
    const known: Record<string, unknown> = {
      first_name: contact?.firstName,
      last_name: contact?.lastName,
      email: contact?.email,
      phone: contact?.phone,
      ...contact?.customFields,
    };
    // The conversation since this flow started (plus a few minutes before, for the comment or
    // message that started it).
    const rows = await db
      .select({ direction: messages.direction, content: messages.content, status: messages.status })
      .from(messages)
      .where(
        and(
          eq(messages.contactId, t.contactId),
          gte(messages.createdAt, new Date(run.startedAt.getTime() - 10 * 60_000)),
        ),
      )
      .orderBy(asc(messages.seq))
      .limit(60);
    const transcript = rows
      .filter((m) => m.status !== 'failed' && m.status !== 'blocked')
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

    const response = await aiClient(ai.apiKey).beta.messages.create(
      {
        model: ai.model.id,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: {
          effort: 'low',
          format: {
            type: 'json_schema',
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
          },
        },
        ...(ai.model.fallbacks
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
        messages: [{ role: 'user', content: brief }],
      },
      // The webhook pass that started this holds its event for two minutes: answer well before.
      { timeout: 45_000, maxRetries: 1 },
    );
    await recordUsage(db, { workspaceId: t.workspaceId }, response);
    if (response.stop_reason === 'refusal') return { outcome: 'handoff' };
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let parsed: z.infer<typeof answer> | undefined;
    try {
      parsed = answer.parse(JSON.parse(text));
    } catch {
      deps.log?.('AI step answer was not valid JSON: handing off', { runId: t.runId });
      return { outcome: 'handoff' };
    }
    return {
      reply: parsed.reply,
      fields: Object.fromEntries(
        parsed.fields.filter((f) => keys.includes(f.key)).map((f) => [f.key, f.value]),
      ),
      outcome: parsed.outcome,
    };
  };
}
