import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../crypto';
import type { Db } from '../db/client';
import { aiUsage, workspaces } from '../db/schema';
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_EFFORT,
  EFFORTS,
  type Effort,
  type Provider,
} from './models';
import { OpenAiError, type OpenAiItem, type OpenAiResponse, openai, outputText } from './openai';

// What every AI feature shares: the workspace's provider, key and model, and one way to ask for
// a structured answer, plain text, or an assistant step, whichever provider runs it.

export type AiClient = Pick<Anthropic, 'beta' | 'models'>;
let makeClient = (apiKey: string): AiClient => new Anthropic({ apiKey, timeout: 180_000 });
export const aiClient = (apiKey: string) => makeClient(apiKey);
/** Swappable for tests. */
export function setAiClient(factory: (apiKey: string) => AiClient) {
  makeClient = factory;
}

export type WorkspaceAi = { provider: Provider; apiKey: string; model: string; effort: Effort };

/** The workspace's chosen provider, its key and model; undefined when that one isn't set up. */
export async function workspaceAi(
  db: Db,
  appSecret: string,
  workspaceId: string,
): Promise<WorkspaceAi | undefined> {
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
  if (!ws) return undefined;
  const effort = (EFFORTS as readonly string[]).includes(ws.effort ?? '')
    ? (ws.effort as Effort)
    : DEFAULT_EFFORT;
  if (ws.provider === 'openai')
    return ws.openaiKeyEnc && ws.openaiModel
      ? {
          provider: 'openai',
          apiKey: decryptSecret(appSecret, ws.openaiKeyEnc),
          model: ws.openaiModel,
          effort,
        }
      : undefined;
  return ws.keyEnc
    ? {
        provider: 'anthropic',
        apiKey: decryptSecret(appSecret, ws.keyEnc),
        model: ws.model ?? DEFAULT_ANTHROPIC_MODEL,
        effort,
      }
    : undefined;
}

export type Usage = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Records one request's tokens for the usage meter. */
export async function recordUsage(
  db: Db,
  who: { workspaceId: string; userId?: string; threadId?: string },
  u: Usage,
) {
  await db.insert(aiUsage).values({
    workspaceId: who.workspaceId,
    userId: who.userId,
    threadId: who.threadId,
    model: u.model,
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
  });
}

const anthropicUsage = (r: Anthropic.Beta.BetaMessage): Usage => ({
  model: r.model,
  input: r.usage.input_tokens,
  output: r.usage.output_tokens,
  cacheRead: r.usage.cache_read_input_tokens ?? 0,
  cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
});
const openaiUsage = (r: OpenAiResponse): Usage => {
  const cached = r.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    model: r.model,
    input: (r.usage?.input_tokens ?? 0) - cached,
    output: r.usage?.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  };
};

/** Plain words for a provider's API failure. */
export function aiErrorText(err: unknown) {
  if (err instanceof OpenAiError) {
    if (err.status === 401) return 'OpenAI refused the API key. Check it in Settings → AI.';
    if (err.status === 403 || err.status === 404)
      return 'That OpenAI key can’t use this model. Pick another model in Settings → AI.';
    if (err.status === 429)
      return err.code === 'insufficient_quota'
        ? 'OpenAI says this key is out of credit. Check billing at platform.openai.com.'
        : 'OpenAI says you’ve hit a rate limit. Wait a minute and try again.';
    if (err.status === 400) return `OpenAI refused the request: ${err.message}`;
    if (err.status === 0) return 'Couldn’t reach OpenAI. Try again in a moment.';
    return `OpenAI had a problem (${err.status}). Try again in a moment.`;
  }
  if (err instanceof Anthropic.AuthenticationError)
    return 'The Anthropic API key was refused. Check it in Settings → AI.';
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError)
    return 'That Anthropic key can’t use this model. Pick another model in Settings → AI.';
  if (err instanceof Anthropic.RateLimitError)
    return 'Anthropic says you’ve hit a rate limit. Wait a minute and try again.';
  if (err instanceof Anthropic.BadRequestError)
    return `Anthropic refused the request: ${err.message}`;
  if (err instanceof Anthropic.APIError)
    return `Anthropic had a problem (${err.status ?? 'no answer'}). Try again in a moment.`;
  return 'Something went wrong talking to the AI. Try again in a moment.';
}

// ------------------------------------------------------------------ optional request features

/**
 * Options some models refuse: server-side fallbacks (newer Claude models only) and effort
 * (reasoning models only). A model that refuses one is remembered and asked without it.
 */
type Optional = 'fallbacks' | 'effort';
const refused = new Map<string, Set<Optional>>();

async function tolerant<T>(ai: WorkspaceAi, run: (skip: ReadonlySet<Optional>) => Promise<T>) {
  const key = `${ai.provider}:${ai.model}`;
  const skip = refused.get(key) ?? new Set<Optional>();
  for (;;) {
    try {
      return await run(skip);
    } catch (err) {
      const bad =
        err instanceof Anthropic.BadRequestError ||
        (err instanceof OpenAiError && err.status === 400);
      const text = bad ? (err as Error).message.toLowerCase() : '';
      const option: Optional | undefined = text.includes('fallback')
        ? 'fallbacks'
        : text.includes('effort') || text.includes('reasoning')
          ? 'effort'
          : undefined;
      if (!option || skip.has(option)) throw err;
      skip.add(option);
      refused.set(key, skip);
    }
  }
}

/** A declined request is retried on a suitable model by Anthropic itself (not on Haiku). */
const fallbacks = (ai: WorkspaceAi, skip: ReadonlySet<Optional>) =>
  skip.has('fallbacks') || ai.model.includes('haiku')
    ? {}
    : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

const anthropicText = (r: Anthropic.Beta.BetaMessage) =>
  r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');

// ------------------------------------------------------------------ one-shot requests

type OneShot = {
  system: string;
  prompt: string;
  maxTokens: number;
  /** Someone or something is waiting: give up after this long (one retry). */
  timeoutMs: number;
};

/**
 * A JSON answer matching `schema` (strict JSON schema: every property required, no extras),
 * thought about lightly. `value` is undefined when the model refused or broke format.
 */
export async function structured(
  ai: WorkspaceAi,
  req: OneShot & { name: string; schema: Record<string, unknown> },
): Promise<{ value: unknown; usage: Usage }> {
  const parse = (text: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  if (ai.provider === 'openai') {
    const r = await tolerant(ai, (skip) =>
      openai<OpenAiResponse>(
        ai.apiKey,
        'POST',
        '/responses',
        {
          model: ai.model,
          instructions: req.system,
          input: req.prompt,
          text: {
            format: { type: 'json_schema', name: req.name, schema: req.schema, strict: true },
          },
          ...(skip.has('effort') ? {} : { reasoning: { effort: 'low' } }),
          max_output_tokens: req.maxTokens,
          store: false,
        },
        req.timeoutMs,
      ),
    );
    const { text, refused: no } = outputText(r);
    return {
      value: no || r.status !== 'completed' ? undefined : parse(text),
      usage: openaiUsage(r),
    };
  }
  const r = await tolerant(ai, (skip) =>
    aiClient(ai.apiKey).beta.messages.create(
      {
        model: ai.model,
        max_tokens: req.maxTokens,
        system: req.system,
        output_config: {
          ...(skip.has('effort') ? {} : { effort: 'low' as const }),
          format: { type: 'json_schema', schema: req.schema },
        },
        ...fallbacks(ai, skip),
        messages: [{ role: 'user', content: req.prompt }],
      },
      { timeout: req.timeoutMs, maxRetries: 1 },
    ),
  );
  return {
    value: r.stop_reason === 'refusal' ? undefined : parse(anthropicText(r)),
    usage: anthropicUsage(r),
  };
}

/** A short piece of writing, thought about lightly. Empty when the model refused. */
export async function plainText(
  ai: WorkspaceAi,
  req: OneShot,
): Promise<{ text: string; usage: Usage }> {
  if (ai.provider === 'openai') {
    const r = await tolerant(ai, (skip) =>
      openai<OpenAiResponse>(
        ai.apiKey,
        'POST',
        '/responses',
        {
          model: ai.model,
          instructions: req.system,
          input: req.prompt,
          ...(skip.has('effort') ? {} : { reasoning: { effort: 'low' } }),
          max_output_tokens: req.maxTokens,
          store: false,
        },
        req.timeoutMs,
      ),
    );
    const { text, refused: no } = outputText(r);
    return { text: no ? '' : text.trim(), usage: openaiUsage(r) };
  }
  const r = await tolerant(ai, (skip) =>
    aiClient(ai.apiKey).beta.messages.create(
      {
        model: ai.model,
        max_tokens: req.maxTokens,
        system: req.system,
        ...(skip.has('effort') ? {} : { output_config: { effort: 'low' as const } }),
        ...fallbacks(ai, skip),
        messages: [{ role: 'user', content: req.prompt }],
      },
      { timeout: req.timeoutMs, maxRetries: 1 },
    ),
  );
  return {
    text: r.stop_reason === 'refusal' ? '' : anthropicText(r).trim(),
    usage: anthropicUsage(r),
  };
}

// ------------------------------------------------------------------ the assistant's steps

/**
 * A stored conversation block. The conversation is kept in Anthropic's shape (text, tool_use,
 * tool_result, plus Claude's own thinking blocks), and OpenAI turns also keep their raw output
 * items as "openai_item" blocks, so either provider can carry on any conversation.
 */
export type StoredBlock = { type: string; [key: string]: unknown };
export type StoredMessage = { role: 'user' | 'assistant'; content: string | StoredBlock[] };
export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
export type StepStop = 'end' | 'tool_use' | 'pause' | 'max_tokens' | 'refusal';

const blocksOf = (m: StoredMessage): StoredBlock[] =>
  typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;

function forAnthropic(messages: StoredMessage[]) {
  return messages.map((m) => {
    if (typeof m.content === 'string' || !m.content.some((b) => b.type === 'openai_item')) return m;
    const content = m.content.filter((b) => b.type !== 'openai_item');
    return { ...m, content: content.length ? content : [{ type: 'text', text: '…' }] };
  }) as unknown as Anthropic.Beta.BetaMessageParam[];
}

const resultText = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: { text?: string }) => c.text ?? '').join('\n')
      : '';

function forOpenAi(messages: StoredMessage[]) {
  const input: unknown[] = [];
  for (const m of messages) {
    const blocks = blocksOf(m);
    if (m.role === 'assistant') {
      // Its own turns go back exactly as they came (reasoning included).
      const native = blocks.filter((b) => b.type === 'openai_item');
      if (native.length) {
        input.push(...native.map((b) => b.item));
        continue;
      }
      for (const b of blocks) {
        if (b.type === 'text' && b.text) input.push({ role: 'assistant', content: b.text });
        if (b.type === 'tool_use')
          input.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
      }
      continue;
    }
    for (const b of blocks)
      if (b.type === 'tool_result')
        input.push({
          type: 'function_call_output',
          call_id: b.tool_use_id,
          output: `${b.is_error ? 'Error: ' : ''}${resultText(b.content)}`,
        });
    const text = blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => String(b.text))
      .join('\n\n');
    if (text) input.push({ role: 'user', content: text });
  }
  return input;
}

/**
 * One step of the assistant: the reply to append to the conversation, why it stopped, and the
 * tokens it used.
 */
export async function chatStep(
  ai: WorkspaceAi,
  req: { system: string; tools: Tool[]; messages: StoredMessage[] },
): Promise<{ content: StoredBlock[]; stop: StepStop; usage: Usage }> {
  if (ai.provider === 'openai') {
    const r = await tolerant(ai, (skip) =>
      openai<OpenAiResponse>(
        ai.apiKey,
        'POST',
        '/responses',
        {
          model: ai.model,
          instructions: req.system,
          input: forOpenAi(req.messages),
          tools: req.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
            strict: false,
          })),
          // Stateless (nothing kept at OpenAI): reasoning comes back encrypted, and goes back.
          ...(skip.has('effort')
            ? {}
            : { reasoning: { effort: ai.effort }, include: ['reasoning.encrypted_content'] }),
          max_output_tokens: 32_000,
          store: false,
        },
        180_000,
      ),
    );
    if (r.status === 'failed') throw new OpenAiError(500, 'OpenAI couldn’t finish that.');
    const content: StoredBlock[] = [];
    let calls = 0;
    for (const item of r.output as OpenAiItem[]) {
      content.push({ type: 'openai_item', item });
      if (item.type === 'message')
        for (const c of (item as Extract<OpenAiItem, { type: 'message' }>).content)
          if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: c.text });
      if (item.type === 'function_call') {
        const call = item as Extract<OpenAiItem, { type: 'function_call' }>;
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {}
        content.push({ type: 'tool_use', id: call.call_id, name: call.name, input });
        calls++;
      }
    }
    const { refused: no } = outputText(r);
    const stop: StepStop =
      no || r.incomplete_details?.reason === 'content_filter'
        ? 'refusal'
        : r.status === 'incomplete'
          ? 'max_tokens'
          : calls
            ? 'tool_use'
            : 'end';
    return { content, stop, usage: openaiUsage(r) };
  }

  const r = await tolerant(ai, (skip) =>
    aiClient(ai.apiKey).beta.messages.create({
      model: ai.model,
      max_tokens: 16000,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: req.tools as Anthropic.Beta.BetaTool[],
      messages: forAnthropic(req.messages),
      ...(skip.has('effort') ? {} : { output_config: { effort: ai.effort } }),
      // Caches the growing conversation too, so each step only pays for what's new.
      cache_control: { type: 'ephemeral' },
      ...fallbacks(ai, skip),
    }),
  );
  const stop: StepStop =
    r.stop_reason === 'refusal'
      ? 'refusal'
      : r.stop_reason === 'pause_turn'
        ? 'pause'
        : r.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : r.content.some((b) => b.type === 'tool_use')
            ? 'tool_use'
            : 'end';
  // The whole content goes back as-is (thinking and fallback blocks included).
  return { content: r.content as unknown as StoredBlock[], stop, usage: anthropicUsage(r) };
}

// ------------------------------------------------------------------ models

export type ListedModel = { id: string; label: string; created: string; note?: string };

// OpenAI's list has no capabilities, so keep to its chat models, without dated snapshots or
// generations too old for structured answers.
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_OTHER =
  /(audio|realtime|live|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|instruct|codex|computer-use|deep-research|oss)/;
const OPENAI_OLD = /^gpt-(3\.5|4)(-turbo)?(-|$)/;
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{4}$/;

/** The provider's current models that can do everything here, newest first. */
export async function listModels(provider: Provider, apiKey: string): Promise<ListedModel[]> {
  const models: ListedModel[] = [];
  if (provider === 'openai') {
    const r = await openai<{
      data: { id: string; created: number; shutdown_date?: string | null }[];
    }>(apiKey, 'GET', '/models', undefined, 15_000);
    for (const m of r.data)
      if (
        OPENAI_CHAT.test(m.id) &&
        !OPENAI_OTHER.test(m.id) &&
        !OPENAI_OLD.test(m.id) &&
        !SNAPSHOT.test(m.id)
      )
        models.push({
          id: m.id,
          label: m.id,
          created: new Date(m.created * 1000).toISOString(),
          note: m.shutdown_date ? `retiring ${m.shutdown_date.slice(0, 10)}` : undefined,
        });
  } else {
    for await (const m of aiClient(apiKey).models.list({ limit: 100 })) {
      if (m.lifecycle === 'retired') continue;
      if (m.capabilities && !m.capabilities.structured_outputs.supported) continue;
      models.push({
        id: m.id,
        label: m.display_name,
        created: m.created_at,
        note: m.lifecycle === 'deprecated' ? 'being retired' : undefined,
      });
    }
  }
  return models.sort((a, b) => b.created.localeCompare(a.created));
}

/** A sensible first pick from a live list: Claude's flagship, or OpenAI's newest full-size model. */
export function suggestedModel(provider: Provider, models: ListedModel[]) {
  const usable = models.filter((m) => !m.note);
  if (provider === 'anthropic')
    return (usable.find((m) => m.id === DEFAULT_ANTHROPIC_MODEL) ?? usable[0])?.id;
  return (usable.find((m) => !/(mini|nano|lite|luna)/.test(m.id)) ?? usable[0])?.id;
}

/** Checks a key can use a model (a lookup, no tokens spent); returns the model's name. */
export async function checkModel(provider: Provider, apiKey: string, model: string) {
  if (provider === 'openai') {
    const m = await openai<{ id: string }>(
      apiKey,
      'GET',
      `/models/${encodeURIComponent(model)}`,
      undefined,
      15_000,
    );
    return m.id;
  }
  const m = await aiClient(apiKey).models.retrieve(model, undefined, { timeout: 15_000 });
  return m.display_name;
}
