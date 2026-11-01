import { describe, expect, it } from 'vitest';
import {
  type AdvanceContext,
  advance,
  type ContactSnapshot,
  type Effect,
  type EngineEvent,
  type RunState,
} from './engine';
import { type FlowGraphInput, flowGraph } from './schema';
import { STARTERS } from './starters';

const NOW = new Date('2026-11-02T17:00:00Z'); // Monday 10:00 in America/Denver

const contact = (over: Partial<ContactSnapshot> = {}): ContactSnapshot => ({
  id: 'c1',
  channel: 'simulator',
  tags: [],
  fields: { first_name: 'Ada' },
  ...over,
});

let tokens = 0;
const ctx = (over: Partial<AdvanceContext> = {}): AdvanceContext => ({
  contact: contact(),
  now: NOW,
  timeZone: 'America/Denver',
  newToken: () => `t${++tokens}`,
  ...over,
});

const graph = (g: FlowGraphInput) => flowGraph.parse(g);
const e = (source: string, sourceHandle: string, target: string) => ({
  id: `${source}.${sourceHandle}`,
  source,
  sourceHandle,
  target,
});
const text = (t: string) => ({ parts: [{ type: 'text' as const, text: t }] });
const sends = (effects: Effect[]) =>
  effects.flatMap((x) =>
    x.type === 'send' ? x.message.parts.map((p) => (p.type === 'text' ? p.text : p.url)) : [],
  );

/** Drives a run through several events, carrying state and contact along like the host does. */
function drive(g: ReturnType<typeof graph>, events: EngineEvent[], c = ctx()) {
  let state: RunState | null = null;
  let snapshot = c.contact;
  const all: Effect[] = [];
  for (const event of events) {
    const r = advance(g, state, event, { ...c, contact: snapshot });
    state = r.state;
    snapshot = r.contact;
    all.push(...r.effects);
  }
  return { state: state as RunState, contact: snapshot, effects: all };
}

describe('linear flows', () => {
  const g = graph({
    nodes: [
      { id: 's', type: 'start' },
      {
        id: 'm',
        type: 'message',
        data: text('Hi {{first_name | there}}, your email is {{email | unknown}}'),
      },
      {
        id: 'a',
        type: 'action',
        data: {
          actions: [
            { type: 'add_tag', tag: 'greeted' },
            { type: 'set_field', key: 'greeting', value: 'hello {{first_name}}' },
          ],
        },
      },
    ],
    edges: [e('s', 'next', 'm'), e('m', 'next', 'a')],
  });

  it('sends rendered messages, applies actions, and completes', () => {
    const r = advance(g, null, { type: 'start' }, ctx());
    expect(r.state).toEqual({ status: 'completed' });
    expect(sends(r.effects)).toEqual(['Hi Ada, your email is unknown']);
    expect(r.effects).toContainEqual({ type: 'add_tag', tag: 'greeted' });
    expect(r.contact.fields.greeting).toBe('hello Ada');
    expect(r.visited).toEqual(['s', 'm', 'a']);
  });

  it('does not re-add an existing tag', () => {
    const r = advance(g, null, { type: 'start' }, ctx({ contact: contact({ tags: ['Greeted'] }) }));
    expect(r.effects.filter((x) => x.type === 'add_tag')).toEqual([]);
  });

  it('fails cleanly when there is no start step', () => {
    const r = advance(graph({ nodes: [], edges: [] }), null, { type: 'start' }, ctx());
    expect(r.state.status).toBe('failed');
  });
});

describe('quick replies', () => {
  const g = graph({
    nodes: [
      { id: 's', type: 'start' },
      {
        id: 'q',
        type: 'message',
        data: {
          ...text('Pick one'),
          quickReplies: [
            { id: 'yes', label: 'Yes please' },
            { id: 'no', label: 'No' },
          ],
          saveReplyTo: 'answer',
        },
      },
      { id: 'y', type: 'message', data: text('yay') },
      { id: 'n', type: 'message', data: text('ok') },
    ],
    edges: [e('s', 'next', 'q'), e('q', 'yes', 'y'), e('q', 'no', 'n')],
  });

  it('waits for a choice and follows the tapped reply', () => {
    const r = drive(g, [{ type: 'start' }, { type: 'choice', nodeId: 'q', handle: 'yes' }]);
    expect(r.state.status).toBe('completed');
    expect(sends(r.effects)).toEqual(['Pick one', 'yay']);
    expect(r.contact.fields.answer).toBe('Yes please');
  });

  it('accepts the reply typed out, ignoring case and spacing', () => {
    const r = drive(g, [{ type: 'start' }, { type: 'message', text: '  yes   PLEASE ' }]);
    expect(sends(r.effects)).toEqual(['Pick one', 'yay']);
  });

  it('leaves unrecognized text unhandled and keeps waiting', () => {
    const started = advance(g, null, { type: 'start' }, ctx());
    const r = advance(g, started.state, { type: 'message', text: 'what?' }, ctx());
    expect(r.handled).toBe(false);
    expect(r.state).toEqual(started.state);
    expect(r.effects).toEqual([]);
  });

  it('routes unrecognized text down "other" when connected, saving it', () => {
    const withOther = graph({ ...g, edges: [...g.edges, e('q', 'other', 'n')] });
    const r = drive(withOther, [{ type: 'start' }, { type: 'message', text: 'Maybe later' }]);
    expect(sends(r.effects)).toEqual(['Pick one', 'ok']);
    expect(r.contact.fields.answer).toBe('Maybe later');
  });

  it('expires after the timeout, or follows "timeout" when connected', () => {
    const started = advance(g, null, { type: 'start' }, ctx());
    const wait = started.state.wait;
    expect(wait?.kind).toBe('choice');
    expect(wait?.until).toBe('2026-11-03T17:00:00.000Z');
    const token = wait?.token ?? '';
    expect(advance(g, started.state, { type: 'wake', token }, ctx()).state).toEqual({
      status: 'expired',
    });

    const withTimeout = graph({ ...g, edges: [...g.edges, e('q', 'timeout', 'n')] });
    const r = advance(withTimeout, started.state, { type: 'wake', token }, ctx());
    expect(sends(r.effects)).toEqual(['ok']);
  });

  it('ignores a wake whose token is stale', () => {
    const started = advance(g, null, { type: 'start' }, ctx());
    const r = advance(g, started.state, { type: 'wake', token: 'old' }, ctx());
    expect(r.handled).toBe(false);
    expect(r.state).toEqual(started.state);
  });
});

describe('ask for input', () => {
  const g = graph({
    nodes: [
      { id: 's', type: 'start' },
      {
        id: 'ask',
        type: 'ask',
        data: {
          question: 'Your email?',
          inputType: 'email',
          saveTo: 'email',
          retryMessage: 'Try again',
          maxRetries: 1,
        },
      },
      { id: 'ok', type: 'message', data: text('Thanks {{email}}') },
      { id: 'bad', type: 'message', data: text('Never mind') },
    ],
    edges: [e('s', 'next', 'ask'), e('ask', 'answered', 'ok'), e('ask', 'failed', 'bad')],
  });

  it('validates, saves and continues', () => {
    const r = drive(g, [{ type: 'start' }, { type: 'message', text: ' Ada@Example.COM ' }]);
    expect(r.contact.fields.email).toBe('ada@example.com');
    expect(sends(r.effects)).toEqual(['Your email?', 'Thanks ada@example.com']);
    expect(r.effects).toContainEqual({ type: 'set_field', key: 'email', value: 'ada@example.com' });
  });

  it('re-prompts, then takes the failed path when retries run out', () => {
    const r = drive(g, [
      { type: 'start' },
      { type: 'message', text: 'nope' },
      { type: 'message', text: 'still nope' },
    ]);
    expect(sends(r.effects)).toEqual(['Your email?', 'Try again', 'Never mind']);
    expect(r.state.status).toBe('completed');
    expect(r.contact.fields.email).toBeUndefined();
  });

  it('keeps the same wake token across retries', () => {
    const started = advance(g, null, { type: 'start' }, ctx());
    const retried = advance(g, started.state, { type: 'message', text: 'nope' }, ctx());
    expect(retried.state.wait?.token).toBe(started.state.wait?.token);
    expect(retried.state.wait).toMatchObject({ kind: 'input', attempts: 1 });
  });
});

describe('branching', () => {
  const g = graph({
    nodes: [
      { id: 's', type: 'start' },
      {
        id: 'c',
        type: 'condition',
        data: {
          cases: [
            {
              id: 'vip',
              match: 'all',
              rules: [
                { subject: 'tag', op: 'has', tag: 'VIP' },
                { subject: 'field', key: 'spend', op: 'greater_than', value: '100' },
              ],
            },
            {
              id: 'weekday',
              rules: [
                { subject: 'weekday', op: 'in', days: [1, 2, 3, 4, 5] },
                { subject: 'hour', op: 'between', from: 9, to: 17 },
              ],
            },
          ],
        },
      },
      { id: 'a', type: 'message', data: text('vip') },
      { id: 'b', type: 'message', data: text('office hours') },
      { id: 'z', type: 'message', data: text('else') },
    ],
    edges: [e('s', 'next', 'c'), e('c', 'vip', 'a'), e('c', 'weekday', 'b'), e('c', 'else', 'z')],
  });
  const run = (c: Partial<ContactSnapshot>, now = NOW) =>
    sends(advance(g, null, { type: 'start' }, ctx({ contact: contact(c), now })).effects);

  it('takes the first matching case', () => {
    expect(run({ tags: ['vip'], fields: { spend: 250 } })).toEqual(['vip']);
    expect(run({ tags: ['vip'], fields: { spend: 50 } })).toEqual(['office hours']);
  });

  it('evaluates weekday and hour in the workspace time zone', () => {
    // 2026-11-03T03:00Z is Monday 20:00 in Denver: a weekday, but outside 9-17.
    expect(run({}, new Date('2026-11-03T03:00:00Z'))).toEqual(['else']);
    // Saturday morning.
    expect(run({}, new Date('2026-11-07T17:00:00Z'))).toEqual(['else']);
  });

  it('splits traffic by weight', () => {
    const split = graph({
      nodes: [
        { id: 's', type: 'start' },
        {
          id: 'x',
          type: 'split',
          data: {
            branches: [
              { id: 'a', label: 'A', weight: 1 },
              { id: 'b', label: 'B', weight: 3 },
            ],
          },
        },
        { id: 'ma', type: 'message', data: text('A') },
        { id: 'mb', type: 'message', data: text('B') },
      ],
      edges: [e('s', 'next', 'x'), e('x', 'a', 'ma'), e('x', 'b', 'mb')],
    });
    const pick = (roll: number) =>
      sends(advance(split, null, { type: 'start' }, ctx({ random: () => roll })).effects);
    expect(pick(0.1)).toEqual(['A']);
    expect(pick(0.3)).toEqual(['B']);
    expect(pick(0.99)).toEqual(['B']);
  });

  it('a case with nothing connected ends the run', () => {
    const r = advance(
      graph({ ...g, edges: g.edges.filter((x) => x.sourceHandle !== 'vip') }),
      null,
      { type: 'start' },
      ctx({ contact: contact({ tags: ['vip'], fields: { spend: 500 } }) }),
    );
    expect(r.state.status).toBe('completed');
    expect(sends(r.effects)).toEqual([]);
  });
});

describe('delays', () => {
  it('waits for the duration, then continues on wake', () => {
    const g = graph({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'd', type: 'delay', data: { mode: 'duration', amount: 2, unit: 'days' } },
        { id: 'm', type: 'message', data: text('later') },
      ],
      edges: [e('s', 'next', 'd'), e('d', 'next', 'm')],
    });
    const started = advance(g, null, { type: 'start' }, ctx());
    expect(started.state.wait).toMatchObject({ kind: 'delay', until: '2026-11-04T17:00:00.000Z' });
    expect(advance(g, started.state, { type: 'message', text: 'hi' }, ctx()).handled).toBe(false);
    const woke = advance(
      g,
      started.state,
      { type: 'wake', token: started.state.wait?.token ?? '' },
      ctx(),
    );
    expect(sends(woke.effects)).toEqual(['later']);
  });

  it('waits until the next matching time of day', () => {
    const g = graph({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'd', type: 'delay', data: { mode: 'until_time', time: '09:00', days: [1, 3, 5] } },
      ],
      edges: [e('s', 'next', 'd')],
    });
    // Monday 10:00 Denver: next Mon/Wed/Fri 09:00 is Wednesday 09:00 MST = 16:00Z.
    expect(advance(g, null, { type: 'start' }, ctx()).state.wait?.until).toBe(
      '2026-11-04T16:00:00.000Z',
    );
  });
});

describe('ending steps and safety', () => {
  it('emits handoff and start_flow effects', () => {
    const g = graph({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'h', type: 'handoff', data: { note: 'help' } },
      ],
      edges: [e('s', 'next', 'h')],
    });
    expect(advance(g, null, { type: 'start' }, ctx()).effects).toEqual([
      { type: 'handoff', note: 'help' },
    ]);

    const goto = graph({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'g', type: 'goto_flow', data: { flowId: 'f2' } },
      ],
      edges: [e('s', 'next', 'g')],
    });
    expect(advance(goto, null, { type: 'start' }, ctx()).effects).toEqual([
      { type: 'start_flow', flowId: 'f2' },
    ]);
  });

  it('stops a loop that never pauses', () => {
    const g = graph({
      nodes: [
        { id: 's', type: 'start' },
        {
          id: 'a',
          type: 'action',
          data: { actions: [{ type: 'set_field', key: 'x', value: '1' }] },
        },
      ],
      edges: [e('s', 'next', 'a'), e('a', 'next', 'a')],
    });
    const r = advance(g, null, { type: 'start' }, ctx());
    expect(r.state.status).toBe('failed');
    expect(r.state.error).toMatch(/loop/);
  });

  it('starts from a tapped flow button', () => {
    const g = graph({
      nodes: [
        { id: 's', type: 'start' },
        {
          id: 'm',
          type: 'message',
          data: { ...text('menu'), buttons: [{ id: 'more', kind: 'flow', label: 'More' }] },
        },
        { id: 'x', type: 'message', data: text('more info') },
      ],
      edges: [e('s', 'next', 'm'), e('m', 'more', 'x')],
    });
    const r = advance(g, null, { type: 'start', from: { nodeId: 'm', handle: 'more' } }, ctx());
    expect(sends(r.effects)).toEqual(['more info']);
  });

  it('percent-encodes variables in URLs', () => {
    const g = graph({
      nodes: [
        { id: 's', type: 'start' },
        {
          id: 'm',
          type: 'message',
          data: {
            ...text('go'),
            buttons: [{ id: 'b', kind: 'url', label: 'Go', url: 'https://x.test/?e={{email}}' }],
          },
        },
      ],
      edges: [e('s', 'next', 'm')],
    });
    const r = advance(
      g,
      null,
      { type: 'start' },
      ctx({ contact: contact({ fields: { email: 'a+b@c.d' } }) }),
    );
    const send = r.effects[0];
    expect(send?.type === 'send' && send.message.buttons[0]).toMatchObject({
      url: 'https://x.test/?e=a%2Bb%40c.d',
    });
  });
});

describe('AI steps', () => {
  const g = graph({
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'chat',
        type: 'ai',
        data: {
          goal: 'Find out which class they want and get their email',
          collect: [{ key: 'class_wanted' }, { key: 'email' }],
          maxTurns: 2,
        },
      },
      { id: 'thanks', type: 'message', data: text('Thanks, {{first_name}}!') },
      { id: 'sorry', type: 'message', data: text('Let me get a person.') },
    ],
    edges: [e('start', 'next', 'chat'), e('chat', 'done', 'thanks'), e('chat', 'gave_up', 'sorry')],
  });
  const turn = (state: RunState | null, event: EngineEvent, c = ctx()) =>
    advance(g, state, event, c);
  const tokenOf = (s: RunState) => (s.wait?.kind === 'ai' ? s.wait.token : '');

  it('asks the host for each reply, sends it as written, and saves only the fields it collects', () => {
    const start = turn(null, { type: 'start' });
    expect(start.effects).toEqual([{ type: 'ai_turn', nodeId: 'chat' }]);
    expect(start.state.wait).toMatchObject({ kind: 'ai', turns: 0, thinking: true });

    const first = turn(start.state, {
      type: 'ai_result',
      token: tokenOf(start.state),
      reply: 'Which class, {{first_name}}?',
      fields: { class_wanted: 'Pottery', secret: 'nope' },
      outcome: 'continue',
    });
    expect(sends(first.effects)).toEqual(['Which class, {{first_name}}?']);
    expect(first.contact.fields).toMatchObject({ class_wanted: 'Pottery' });
    expect(first.contact.fields).not.toHaveProperty('secret');
    expect(first.state.wait).toMatchObject({ kind: 'ai', turns: 1, thinking: false });

    const answered = turn(
      first.state,
      { type: 'message', text: 'ada@example.com' },
      ctx({ contact: first.contact }),
    );
    expect(answered.effects).toEqual([{ type: 'ai_turn', nodeId: 'chat' }]);
    const done = turn(
      answered.state,
      {
        type: 'ai_result',
        token: tokenOf(answered.state),
        fields: { email: 'ada@example.com' },
        outcome: 'done',
      },
      ctx({ contact: answered.contact }),
    );
    expect(sends(done.effects)).toEqual(['Thanks, Ada!']);
    expect(done.state.status).toBe('completed');
  });

  it('ignores a stale result, and takes another turn for a message sent while it was thinking', () => {
    const start = turn(null, { type: 'start' });
    expect(turn(start.state, { type: 'ai_result', token: 'old', outcome: 'done' }).handled).toBe(
      false,
    );
    const meanwhile = turn(start.state, { type: 'message', text: 'also, is it on Saturday?' });
    expect(meanwhile.handled).toBe(true);
    expect(meanwhile.effects).toEqual([]);
    const result = turn(meanwhile.state, {
      type: 'ai_result',
      token: tokenOf(meanwhile.state),
      reply: 'Hi!',
      outcome: 'continue',
    });
    expect(result.effects.map((x) => x.type)).toEqual(['send', 'ai_turn']);
    expect(result.state.wait).toMatchObject({ thinking: true, turns: 1 });
  });

  it('gives up after maxTurns replies, and hands off when asked with nothing connected', () => {
    let state = turn(null, { type: 'start' }).state;
    for (let i = 0; i < 2; i++) {
      state = turn(state, {
        type: 'ai_result',
        token: tokenOf(state),
        reply: `Reply ${i}`,
        outcome: 'continue',
      }).state;
      if (i < 1) state = turn(state, { type: 'message', text: 'hm' }).state;
    }
    const gaveUp = turn(state, { type: 'message', text: 'still unsure' });
    expect(sends(gaveUp.effects)).toEqual(['Let me get a person.']);

    const start = turn(null, { type: 'start' });
    const handoff = turn(start.state, {
      type: 'ai_result',
      token: tokenOf(start.state),
      outcome: 'handoff',
    });
    expect(handoff.effects).toContainEqual({
      type: 'handoff',
      note: 'The AI step asked for a person.',
    });
    expect(handoff.state.status).toBe('completed');
  });
});

describe('AI sort steps', () => {
  const g = graph({
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'sort',
        type: 'ai_route',
        data: {
          intents: [
            { id: 'price', label: 'Pricing', description: 'asks what it costs' },
            { id: 'book', label: 'Booking' },
          ],
          saveTo: 'topic',
        },
      },
      { id: 'prices', type: 'message', data: text('Classes are $40.') },
      { id: 'fallback', type: 'message', data: text('Tell me more?') },
    ],
    edges: [
      e('start', 'next', 'sort'),
      e('sort', 'price', 'prices'),
      e('sort', 'else', 'fallback'),
    ],
  });
  const tokenOf = (s: RunState) => (s.wait?.kind === 'route' ? s.wait.token : '');

  it('asks the host to sort, then follows the picked intent and saves its label', () => {
    const start = advance(g, null, { type: 'start' }, ctx());
    expect(start.effects).toEqual([{ type: 'ai_route', nodeId: 'sort' }]);
    expect(start.state.wait).toMatchObject({ kind: 'route', until: '2026-11-02T17:10:00.000Z' });
    expect(
      advance(g, start.state, { type: 'ai_route_result', token: 'old', intent: 'price' }, ctx())
        .handled,
    ).toBe(false);
    // A message while it sorts is taken in, not treated as a fresh conversation.
    const meanwhile = advance(g, start.state, { type: 'message', text: 'and when?' }, ctx());
    expect(meanwhile).toMatchObject({ handled: true, effects: [], state: start.state });

    const picked = advance(
      g,
      start.state,
      { type: 'ai_route_result', token: tokenOf(start.state), intent: 'price' },
      ctx(),
    );
    expect(sends(picked.effects)).toEqual(['Classes are $40.']);
    expect(picked.contact.fields).toMatchObject({ topic: 'Pricing' });
  });

  it('goes through "else" for no match, an unknown intent, or no answer in time', () => {
    const start = advance(g, null, { type: 'start' }, ctx());
    const token = tokenOf(start.state);
    for (const event of [
      { type: 'ai_route_result', token } as const,
      { type: 'ai_route_result', token, intent: 'made_up' } as const,
      { type: 'wake', token } as const,
    ]) {
      const r = advance(g, start.state, event, ctx());
      expect(sends(r.effects)).toEqual(['Tell me more?']);
      expect(r.contact.fields).not.toHaveProperty('topic');
    }
    // "Booking" matched but leads nowhere: the run just ends.
    const unconnected = advance(
      g,
      start.state,
      { type: 'ai_route_result', token, intent: 'book' },
      ctx(),
    );
    expect(unconnected.state.status).toBe('completed');
    expect(unconnected.contact.fields).toMatchObject({ topic: 'Booking' });
    // An earlier pick is emptied when this message fits none of the paths.
    const later = advance(
      g,
      start.state,
      { type: 'ai_route_result', token },
      ctx({ contact: contact({ fields: { topic: 'Pricing' } }) }),
    );
    expect(later.effects).toContainEqual({ type: 'clear_field', key: 'topic' });
    expect(later.contact.fields.topic).toBeNull();
  });
});

describe('the lead magnet starter (WORKSHOP scenario)', () => {
  const starter = STARTERS.find((s) => s.key === 'lead_magnet');
  const g = graph(starter?.graph ?? { nodes: [], edges: [] });

  it('runs from keyword to delivered worksheet', () => {
    const r = drive(g, [
      { type: 'start' },
      { type: 'choice', nodeId: 'pick_topic', handle: 'topic_advanced' },
      { type: 'message', text: 'not an email' },
      { type: 'message', text: 'ada@example.com' },
    ]);
    expect(r.state.status).toBe('completed');
    expect(r.contact.tags).toEqual(['workshop-interest', 'lead']);
    expect(r.contact.fields).toMatchObject({ interest: 'Advanced', email: 'ada@example.com' });
    expect(r.effects).toContainEqual({ type: 'set_consent', channel: 'email', granted: true });
    const last = r.effects.filter((x) => x.type === 'send').at(-1);
    expect(
      last?.type === 'send' && last.message.buttons.map((b) => (b.kind === 'url' ? b.url : '')),
    ).toEqual([
      'https://example.com/worksheet',
      'https://example.com/register?email=ada%40example.com',
    ]);
  });
});
