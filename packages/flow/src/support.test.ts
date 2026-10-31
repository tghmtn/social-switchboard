import { describe, expect, it } from 'vitest';
import { parseInput } from './inputs';
import { flowGraph } from './schema';
import { STARTERS } from './starters';
import { nextTimeOfDay, zonedToUtc } from './time';
import { keywordMatches, matchCommentTrigger, matchTrigger, type TriggerConfig } from './triggers';
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
    expect(pick({ channel: 'simulator', text: 'promo', isNewContact: false })).toBe('default');
    expect(pick({ channel: 'instagram', text: 'promo', isNewContact: false })).toBe('ig-only');
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
