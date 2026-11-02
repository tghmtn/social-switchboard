import { describe, expect, it } from 'vitest';
import { parseInput } from './inputs';
import { flowGraph } from './schema';
import { STARTERS } from './starters';
import { nextTimeOfDay, zonedToUtc } from './time';
import {
  keywordMatches,
  matchCommentTrigger,
  matchTrigger,
  type TriggerConfig,
  triggerOverlap,
} from './triggers';
import { validateFlow } from './validate';

describe('validateFlow', () => {
  it('passes every starter with no errors or warnings', () => {
    for (const s of STARTERS) {
      const issues = validateFlow(flowGraph.parse(s.graph));
      expect(
        issues.filter((i) => s.key !== 'blank' || i.code !== 'start_unconnected'),
        s.key,
      ).toEqual([]);
    }
  });

  it('reports wiring problems', () => {
    const g = flowGraph.parse({
      nodes: [
        { id: 's', type: 'start' },
        { id: 's2', type: 'start' },
        { id: 'm', type: 'message', data: { parts: [{ type: 'text', text: 'hi' }] } },
        { id: 'orphan', type: 'handoff', data: {} },
      ],
      edges: [
        { id: 'e1', source: 's', sourceHandle: 'next', target: 'm' },
        { id: 'e2', source: 's', sourceHandle: 'next', target: 'orphan' },
        { id: 'e3', source: 'm', sourceHandle: 'nope', target: 'orphan' },
        { id: 'e4', source: 'm', sourceHandle: 'next', target: 'ghost' },
        { id: 'e5', source: 'm', sourceHandle: 'next', target: 's2' },
      ],
    });
    const codes = validateFlow(g).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'multiple_starts',
        'handle_multiple_edges',
        'edge_unknown_handle',
        'edge_unknown_node',
        'edge_into_start',
      ]),
    );
  });

  it('warns about unreachable steps', () => {
    const g = flowGraph.parse({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'h', type: 'handoff', data: {} },
      ],
      edges: [],
    });
    expect(validateFlow(g).map((i) => [i.code, i.severity])).toEqual([
      ['start_unconnected', 'warning'],
      ['unreachable', 'warning'],
    ]);
  });
});

describe('triggers', () => {
  const kw = (
    keywords: string[],
    match: 'exact' | 'contains' | 'starts_with',
  ): Extract<TriggerConfig, { type: 'keyword' }> => ({
    type: 'keyword',
    keywords,
    match,
  });

  it('matches keywords by mode, ignoring case and punctuation', () => {
    expect(keywordMatches(kw(['WORKSHOP'], 'exact'), 'workshop!')).toBe(true);
    expect(keywordMatches(kw(['WORKSHOP'], 'exact'), 'the workshop')).toBe(false);
    expect(keywordMatches(kw(['guide'], 'contains'), 'Can I get the GUIDE please')).toBe(true);
    expect(keywordMatches(kw(['guide'], 'contains'), 'guidelines?')).toBe(false);
    expect(keywordMatches(kw(['price'], 'starts_with'), 'price for two?')).toBe(true);
    expect(keywordMatches(kw(['price'], 'starts_with'), 'pricey')).toBe(false);
  });

  it('prefers ref, then keyword, then welcome, then default reply', () => {
    const triggers = [
      { id: 'default', config: { type: 'default_reply' } as const },
      { id: 'welcome', config: { type: 'welcome' } as const },
      { id: 'kw', config: kw(['hi'], 'exact') },
      { id: 'ig-only', config: kw(['promo'], 'exact'), channels: ['instagram'] },
      { id: 'ref', config: { type: 'ref', ref: 'spring' } as const },
    ];
    const pick = (event: Parameters<typeof matchTrigger>[1]) => matchTrigger(triggers, event)?.id;
    expect(pick({ channel: 'simulator', ref: 'spring', isNewContact: true })).toBe('ref');
    expect(pick({ channel: 'simulator', ref: 'other', isNewContact: true })).toBeUndefined();
    expect(pick({ channel: 'simulator', text: 'Hi', isNewContact: true })).toBe('kw');
    expect(pick({ channel: 'simulator', text: 'hello', isNewContact: true })).toBe('welcome');
    expect(pick({ channel: 'simulator', text: 'hello', isNewContact: false })).toBe('default');
    expect(pick({ channel: 'facebook', text: 'promo', isNewContact: false })).toBe('default');
    expect(pick({ channel: 'instagram', text: 'promo', isNewContact: false })).toBe('ig-only');
    // Test chat stands in for every platform, so an Instagram-only trigger answers there too.
    expect(pick({ channel: 'simulator', text: 'promo', isNewContact: false })).toBe('ig-only');
  });

  it('answers story mentions and replies, a specific story first', () => {
    type StoryReply = Extract<TriggerConfig, { type: 'story_reply' }>;
    const reply = (
      id: string,
      over: Partial<StoryReply> = {},
    ): { id: string; config: TriggerConfig } => {
      const config: StoryReply = {
        type: 'story_reply',
        keywords: [],
        match: 'contains',
        storyIds: [],
        ...over,
      };
      return { id, config };
    };
    const triggers: { id: string; config: TriggerConfig }[] = [
      reply('any'),
      reply('guide', { keywords: ['guide'] }),
      reply('this-story', { storyIds: ['s1'] }),
      { id: 'mention', config: { type: 'story_mention' } as const },
      { id: 'kw', config: kw(['hi'], 'exact') },
    ];
    const pick = (event: Parameters<typeof matchTrigger>[1]) => matchTrigger(triggers, event)?.id;
    const story = (id?: string) => ({ kind: 'reply' as const, id });
    expect(pick({ channel: 'instagram', story: { kind: 'mention' }, isNewContact: false })).toBe(
      'mention',
    );
    expect(
      pick({ channel: 'instagram', text: 'wow', story: story('s1'), isNewContact: false }),
    ).toBe('this-story');
    // In order: "any reply" comes before the keyword one, so it takes everything.
    expect(
      pick({ channel: 'instagram', text: 'guide', story: story('s2'), isNewContact: false }),
    ).toBe('any');
    // A sticker or photo reply has no words; only "any reply" triggers take it.
    expect(pick({ channel: 'instagram', story: story('s2'), isNewContact: false })).toBe('any');
    // With no story trigger left to take it, a story reply is an ordinary DM.
    const dmOnly = triggers.filter((t) => t.config.type !== 'story_reply');
    expect(
      matchTrigger(dmOnly, {
        channel: 'instagram',
        text: 'hi',
        story: story('s2'),
        isNewContact: false,
      })?.id,
    ).toBe('kw');
  });
});

describe('comment triggers', () => {
  const comment = (
    id: string,
    over: Partial<Extract<TriggerConfig, { type: 'comment' }>> = {},
  ) => ({
    id,
    config: {
      type: 'comment',
      keywords: [],
      match: 'contains',
      mediaIds: [],
      publicReplies: [],
      ...over,
    } as TriggerConfig,
  });

  it('prefers triggers for the specific post, then any post, honoring keywords', () => {
    const triggers = [
      comment('any-guide', { keywords: ['guide'] }),
      comment('post-1-any', { mediaIds: ['111'] }),
      comment('post-2-link', { mediaIds: ['222'], keywords: ['LINK'], match: 'exact' }),
      {
        id: 'dm-keyword',
        config: { type: 'keyword', keywords: ['guide'], match: 'exact' } as TriggerConfig,
      },
    ];
    const pick = (text: string, mediaId?: string) =>
      matchCommentTrigger(triggers, { channel: 'instagram', text, mediaId })?.id;
    expect(pick('love this!', '111')).toBe('post-1-any');
    expect(pick('link!', '222')).toBe('post-2-link');
    expect(pick('send the guide please', '222')).toBe('any-guide');
    expect(pick('nice', '333')).toBeUndefined();
    expect(
      matchTrigger(triggers, { channel: 'instagram', text: 'love this', isNewContact: false }),
    ).toBeUndefined();
  });
});

describe('triggerOverlap', () => {
  const t = (config: TriggerConfig, channels: string[] | null = null) => ({ config, channels });
  const keyword = (...keywords: string[]) =>
    t({ type: 'keyword', keywords, match: 'exact' } as const);
  const comment = (keywords: string[], mediaIds: string[] = []) =>
    t({ type: 'comment', keywords, match: 'contains', mediaIds, publicReplies: [] });

  it('names what two triggers both answer', () => {
    expect(triggerOverlap(keyword('GUIDE', 'free'), keyword('Guide!'))).toBe('“GUIDE”');
    expect(triggerOverlap(keyword('GUIDE'), keyword('WORKSHOP'))).toBeUndefined();
    expect(triggerOverlap(t({ type: 'welcome' }), t({ type: 'welcome' }))).toBe('first messages');
    expect(triggerOverlap(t({ type: 'welcome' }), keyword('GUIDE'))).toBeUndefined();
    expect(triggerOverlap(comment(['guide']), comment(['GUIDE'], ['1']))).toBe(
      'comments with “guide”',
    );
    expect(triggerOverlap(comment([]), comment(['GUIDE']))).toBe('any comment');
  });

  it('ignores triggers on different posts or channels', () => {
    expect(triggerOverlap(comment(['GUIDE'], ['1']), comment(['GUIDE'], ['2']))).toBeUndefined();
    const ig = t({ type: 'welcome' }, ['instagram']);
    expect(triggerOverlap(ig, t({ type: 'welcome' }, ['webchat']))).toBeUndefined();
    expect(triggerOverlap(ig, t({ type: 'welcome' }))).toBe('first messages');
    const story = (keywords: string[], storyIds: string[] = []) =>
      t({ type: 'story_reply', keywords, match: 'contains', storyIds });
    expect(triggerOverlap(story(['guide']), story(['GUIDE']))).toBe('story replies with “guide”');
    expect(triggerOverlap(story([], ['a']), story([], ['b']))).toBeUndefined();
    expect(triggerOverlap(t({ type: 'story_mention' }), t({ type: 'story_mention' }))).toBe(
      'story mentions',
    );
  });
});

describe('parseInput', () => {
  it('normalizes valid answers and rejects bad ones', () => {
    expect(parseInput('email', ' A@B.co ')).toBe('a@b.co');
    expect(parseInput('email', 'a@b')).toBeNull();
    expect(parseInput('phone', '+1 (801) 555-0100')).toBe('+18015550100');
    expect(parseInput('phone', 'call me')).toBeNull();
    expect(parseInput('number', '1,250.5')).toBe(1250.5);
    expect(parseInput('number', 'ten')).toBeNull();
    expect(parseInput('url', 'example.com/x')).toBe('https://example.com/x');
    expect(parseInput('text', '   ')).toBeNull();
  });
});

describe('time zones', () => {
  it('converts wall-clock time across daylight saving changes', () => {
    expect(zonedToUtc(2026, 7, 1, 9, 0, 'America/Denver').toISOString()).toBe(
      '2026-07-01T15:00:00.000Z',
    );
    expect(zonedToUtc(2026, 12, 1, 9, 0, 'America/Denver').toISOString()).toBe(
      '2026-12-01T16:00:00.000Z',
    );
  });

  it('finds the next time of day across the fall-back weekend', () => {
    // Saturday 2026-10-31 20:00 MDT. DST ends Sunday 2026-11-01 at 02:00.
    const now = new Date('2026-11-01T02:00:00Z');
    expect(nextTimeOfDay(now, '09:00', [], 'America/Denver').toISOString()).toBe(
      '2026-11-01T16:00:00.000Z',
    );
    expect(nextTimeOfDay(now, '09:00', [1], 'America/Denver').toISOString()).toBe(
      '2026-11-02T16:00:00.000Z',
    );
  });
});
