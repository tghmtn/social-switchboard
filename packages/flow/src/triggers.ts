import { z } from 'zod';

// Triggers decide which flow a fresh conversation starts.

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
  /**
   * A comment on a post. The flow's first message goes out as Instagram's one private reply to
   * that comment; the conversation continues once the person replies or taps a button.
   */
  z.object({
    type: z.literal('comment'),
    /** Empty: any comment. */
    keywords: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    match: z.enum(['exact', 'contains', 'starts_with']).default('contains'),
    /** Empty: any post. */
    mediaIds: z
      .array(z.string().regex(/^[0-9A-Za-z_]{1,64}$/))
      .max(50)
      .default([]),
    /** Optional public replies under the comment; one is picked at random. */
    publicReplies: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  }),
  /** A reply to one of the account's stories (Instagram). It arrives as a DM, so the window is open. */
  z.object({
    type: z.literal('story_reply'),
    /** Empty: any reply. */
    keywords: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    match: z.enum(['exact', 'contains', 'starts_with']).default('contains'),
    /** Empty: any story. Stories last a day, so a picked one stops getting replies when it's gone. */
    storyIds: z
      .array(z.string().regex(/^[0-9A-Za-z_]{1,64}$/))
      .max(50)
      .default([]),
  }),
  /** Someone mentions the account in their own story (Instagram). */
  z.object({ type: z.literal('story_mention') }),
]);

export type TriggerConfig = z.infer<typeof triggerConfig>;
export type TriggerType = TriggerConfig['type'];

export type TriggerEvent = {
  channel: string;
  text?: string;
  ref?: string;
  /** A reply to one of the account's stories, or a mention in theirs. */
  story?: StoryEvent;
  isNewContact: boolean;
};
export type StoryEvent = { kind: 'reply' | 'mention'; id?: string };
type Matchable = { config: TriggerConfig; channels?: string[] | null };

/** Whether a trigger listens on this channel. Test chat stands in for every channel. */
const listensOn = (t: Matchable, channel: string) =>
  !t.channels?.length || channel === 'simulator' || t.channels.includes(channel);

// Ignore case, extra spaces and surrounding punctuation, so "Workshop!" matches "WORKSHOP".
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const normalizeText = (s: string) =>
  s.toLowerCase().replace(/\s+/g, ' ').trim().replace(EDGES, '');

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function keywordMatches(
  config: { keywords: string[]; match: 'exact' | 'contains' | 'starts_with' },
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
 * Picks the trigger for an incoming event. Order: ref link, story mention, story reply, then
 * keywords (in the order given), then welcome for new contacts, then the default reply. A story
 * reply no story trigger takes is an ordinary DM, so keyword triggers still catch it.
 */
export function matchTrigger<T extends Matchable>(
  triggers: T[],
  event: TriggerEvent,
): T | undefined {
  const eligible = triggers.filter((t) => listensOn(t, event.channel));
  const ofType = <K extends TriggerType>(type: K) =>
    eligible.filter(
      (t): t is T & { config: Extract<TriggerConfig, { type: K }> } => t.config.type === type,
    );

  if (event.ref !== undefined) return ofType('ref').find((t) => t.config.ref === event.ref);
  if (event.story?.kind === 'mention') return ofType('story_mention')[0];
  const story = event.story;
  if (story?.kind === 'reply') {
    // Like comments: triggers on this very story first, then "any story" ones. No keywords
    // means any reply, a photo or sticker with no words included.
    const replies = ofType('story_reply');
    const fits = (c: Extract<TriggerConfig, { type: 'story_reply' }>) =>
      c.keywords.length === 0 || (event.text !== undefined && keywordMatches(c, event.text));
    const found =
      replies.find(
        (t) => story.id !== undefined && t.config.storyIds.includes(story.id) && fits(t.config),
      ) ?? replies.find((t) => t.config.storyIds.length === 0 && fits(t.config));
    if (found) return found;
  }
  if (event.text === undefined) return undefined;

  const text = event.text;
  return (
    ofType('keyword').find((t) => keywordMatches(t.config, text)) ??
    (event.isNewContact ? ofType('welcome')[0] : undefined) ??
    ofType('default_reply')[0]
  );
}

/**
 * What two triggers would both answer, if anything, like `“GUIDE”` or `first messages`. Only one
 * of them runs, so the builder warns (a duplicated automation keeps the original's keywords).
 */
export function triggerOverlap(a: Matchable, b: Matchable): string | undefined {
  if (a.channels?.length && b.channels?.length && !a.channels.some((c) => b.channels?.includes(c)))
    return undefined;
  const x = a.config;
  const y = b.config;
  if (x.type === 'welcome' && y.type === 'welcome') return 'first messages';
  if (x.type === 'default_reply' && y.type === 'default_reply')
    return 'messages nothing else answers';
  if (x.type === 'ref' && y.type === 'ref') return x.ref === y.ref ? `ref=${x.ref}` : undefined;
  if (x.type === 'story_mention' && y.type === 'story_mention') return 'story mentions';
  const words = (k: string[]) => new Set(k.map(normalizeText));
  if (x.type === 'keyword' && y.type === 'keyword') {
    const theirs = words(y.keywords);
    const shared = x.keywords.find((k) => theirs.has(normalizeText(k)));
    return shared === undefined ? undefined : `“${shared}”`;
  }
  if (x.type === 'comment' && y.type === 'comment') {
    if (x.mediaIds.length && y.mediaIds.length && !x.mediaIds.some((m) => y.mediaIds.includes(m)))
      return undefined;
    if (!x.keywords.length || !y.keywords.length) return 'any comment';
    const theirs = words(y.keywords);
    const shared = x.keywords.find((k) => theirs.has(normalizeText(k)));
    return shared === undefined ? undefined : `comments with “${shared}”`;
  }
  if (x.type === 'story_reply' && y.type === 'story_reply') {
    if (x.storyIds.length && y.storyIds.length && !x.storyIds.some((m) => y.storyIds.includes(m)))
      return undefined;
    if (!x.keywords.length || !y.keywords.length) return 'any story reply';
    const theirs = words(y.keywords);
    const shared = x.keywords.find((k) => theirs.has(normalizeText(k)));
    return shared === undefined ? undefined : `story replies with “${shared}”`;
  }
  return undefined;
}

export type CommentEvent = { channel: string; text: string; mediaId?: string };

/**
 * Picks the trigger for a comment. Triggers set up for this specific post win over "any post"
 * ones; within each group the first match (by position) wins. No keywords means any comment.
 */
export function matchCommentTrigger<T extends Matchable>(
  triggers: T[],
  event: CommentEvent,
): T | undefined {
  const candidates = triggers.filter(
    (t): t is T & { config: Extract<TriggerConfig, { type: 'comment' }> } =>
      t.config.type === 'comment' && listensOn(t, event.channel),
  );
  const matchesText = (c: Extract<TriggerConfig, { type: 'comment' }>) =>
    c.keywords.length === 0 || keywordMatches(c, event.text);
  const forThisPost = candidates.filter(
    (t) => event.mediaId !== undefined && t.config.mediaIds.includes(event.mediaId),
  );
  const anyPost = candidates.filter((t) => t.config.mediaIds.length === 0);
  return (
    forThisPost.find((t) => matchesText(t.config)) ?? anyPost.find((t) => matchesText(t.config))
  );
}
