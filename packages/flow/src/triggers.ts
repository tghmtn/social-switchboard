import { z } from 'zod';

// Triggers decide which flow a fresh conversation starts. Instagram-specific triggers
// (comment keywords, story replies) arrive with the Instagram channel in Phase 2.

export const triggerConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('keyword'),
    keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    /** exact: the whole message; contains: anywhere as a whole word; starts_with: the first words. */
    match: z.enum(['exact', 'contains', 'starts_with']).default('exact'),
  }),
  /** The first message a brand-new contact sends, when no keyword matched. */
  z.object({ type: z.literal('welcome') }),
  /** Any message nothing else handled. */
  z.object({ type: z.literal('default_reply') }),
  /** Entry links that carry ?ref=<ref> (e.g. ig.me/m/you?ref=workshop). */
  z.object({ type: z.literal('ref'), ref: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
]);

export type TriggerConfig = z.infer<typeof triggerConfig>;
export type TriggerType = TriggerConfig['type'];

export type TriggerEvent = { channel: string; text?: string; ref?: string; isNewContact: boolean };
type Matchable = { config: TriggerConfig; channels?: string[] | null };

// Ignore case, extra spaces and surrounding punctuation, so "Workshop!" matches "WORKSHOP".
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const normalizeText = (s: string) =>
  s.toLowerCase().replace(/\s+/g, ' ').trim().replace(EDGES, '');

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function keywordMatches(
  config: Extract<TriggerConfig, { type: 'keyword' }>,
  text: string,
): boolean {
  const message = normalizeText(text);
  return config.keywords.some((raw) => {
    const keyword = normalizeText(raw);
    if (!keyword) return false;
    switch (config.match) {
      case 'exact':
        return message === keyword;
      case 'starts_with':
        return message === keyword || message.startsWith(`${keyword} `);
      case 'contains':
        return new RegExp(
          `(^|[^\\p{L}\\p{N}])${escapeRegExp(keyword)}([^\\p{L}\\p{N}]|$)`,
          'u',
        ).test(message);
    }
    return false;
  });
}

/**
 * Picks the trigger for an incoming event. Order: ref link, then keywords (in the order
 * given), then welcome for new contacts, then the default reply.
 */
export function matchTrigger<T extends Matchable>(
  triggers: T[],
  event: TriggerEvent,
): T | undefined {
  const eligible = triggers.filter(
    (t) => !t.channels?.length || t.channels.includes(event.channel),
  );
  const ofType = <K extends TriggerType>(type: K) =>
    eligible.filter(
      (t): t is T & { config: Extract<TriggerConfig, { type: K }> } => t.config.type === type,
    );

  if (event.ref !== undefined) return ofType('ref').find((t) => t.config.ref === event.ref);
  if (event.text === undefined) return undefined;

  const text = event.text;
  return (
    ofType('keyword').find((t) => keywordMatches(t.config, text)) ??
    (event.isNewContact ? ofType('welcome')[0] : undefined) ??
    ofType('default_reply')[0]
  );
}
