import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../crypto';
import type { Db } from '../db/client';
import { aiUsage, workspaces } from '../db/schema';
import { DEFAULT_EFFORT, EFFORTS, type Effort, modelFor } from './models';

// What every AI feature shares: the workspace's key and model, the Claude client, and usage.

export type AiClient = Pick<Anthropic, 'beta'>;
let makeClient = (apiKey: string): AiClient => new Anthropic({ apiKey, timeout: 180_000 });
export const aiClient = (apiKey: string) => makeClient(apiKey);
/** Swappable for tests. */
export function setAiClient(factory: (apiKey: string) => AiClient) {
  makeClient = factory;
}

/** The workspace's AI settings, or undefined when no key is saved. */
export async function workspaceAi(db: Db, appSecret: string, workspaceId: string) {
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

/** Records one request's tokens for the usage meter. */
export async function recordUsage(
  db: Db,
  who: { workspaceId: string; userId?: string; threadId?: string },
  response: { model: string; usage: Anthropic.Beta.BetaUsage },
) {
  await db.insert(aiUsage).values({
    workspaceId: who.workspaceId,
    userId: who.userId,
    threadId: who.threadId,
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  });
}

/** Plain words for an Anthropic API failure. */
export function aiErrorText(err: unknown) {
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
