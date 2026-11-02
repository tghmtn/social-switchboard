import { evaluateCase } from './conditions';
import { type GraphIndex, indexGraph } from './handles';
import { parseInput } from './inputs';
import type { Action, Button, FlowGraph, MessagePart, NodeOf, QuickReply } from './schema';
import { renderTemplate, renderUrl } from './template';
import { nextTimeOfDay } from './time';

// The engine is a pure function: (graph, run state, event, contact) -> (new state, effects).
// It never touches a database or a channel. The host persists the state, applies the effects
// (sends messages, saves tags/fields) and calls advance() again when the contact replies or a
// timer fires. That keeps every behavior here unit-testable without infrastructure.

export type FieldValue = string | number | boolean | null;

/** What the engine knows about a contact. System fields (email, first_name, ...) live in `fields` too. */
export type ContactSnapshot = {
  id: string;
  channel: string;
  tags: string[];
  fields: Record<string, FieldValue>;
  /** Whether they follow the account they're talking to; null or absent when the channel hasn't said. */
  followsUs?: boolean | null;
};

export type RunWait =
  | { kind: 'delay'; nodeId: string; until: string; token: string }
  | { kind: 'input'; nodeId: string; attempts: number; until: string; token: string }
  | { kind: 'choice'; nodeId: string; until: string; token: string }
  /**
   * An AI step. `thinking`: the host is getting its next reply. `missed`: they wrote again
   * meanwhile, so that reply is followed by another turn instead of waiting.
   */
  | {
      kind: 'ai';
      nodeId: string;
      turns: number;
      thinking: boolean;
      missed: boolean;
      until: string;
      token: string;
    }
  /** An AI sort step: the host is reading their message. */
  | { kind: 'route'; nodeId: string; until: string; token: string };

export type RunStatus = 'waiting' | 'completed' | 'failed' | 'expired';
export type RunState = { status: RunStatus; wait?: RunWait; error?: string };

export type EngineEvent =
  /** Begin a run at the start step, or (for a tapped flow button) at the edge leaving `from`. */
  | { type: 'start'; from?: { nodeId: string; handle: string } }
  /** Text the contact sent while this run may be waiting for it. */
  | { type: 'message'; text: string }
  /** A quick reply or button tapped on the step the run is waiting at. */
  | { type: 'choice'; nodeId: string; handle: string }
  /** A delay or reply timeout came due; `token` must match the current wait. */
  | { type: 'wake'; token: string }
  /** The AI step's next turn, from the host; `token` must match the current wait. */
  | {
      type: 'ai_result';
      token: string;
      reply?: string;
      fields?: Record<string, string>;
      outcome: 'continue' | 'done' | 'handoff';
    }
  /** The AI sort step's pick (an intent id; none means "else"); `token` must match. */
  | { type: 'ai_route_result'; token: string; intent?: string };

export type OutboundButton =
  | { id: string; kind: 'url'; label: string; url: string }
  | { id: string; kind: 'flow'; label: string };
export type OutboundMessage = {
  parts: MessagePart[];
  buttons: OutboundButton[];
  quickReplies: QuickReply[];
};

export type Effect =
  | { type: 'send'; nodeId: string; message: OutboundMessage }
  | { type: 'add_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'set_field'; key: string; value: FieldValue }
  | { type: 'clear_field'; key: string }
  | { type: 'set_consent'; channel: 'email' | 'sms'; granted: boolean }
  | { type: 'notify_team'; message: string }
  | { type: 'handoff'; note?: string }
  | { type: 'start_flow'; flowId: string }
  /** The host should get the AI step's next reply and come back with an ai_result. */
  | { type: 'ai_turn'; nodeId: string }
  /** The host should sort their latest message and come back with an ai_route_result. */
  | { type: 'ai_route'; nodeId: string };

export type AdvanceContext = {
  contact: ContactSnapshot;
  now: Date;
  /** IANA zone used for time conditions and "until HH:MM" delays. */
  timeZone: string;
  random?: () => number;
  newToken?: () => string;
};

export type AdvanceResult = {
  /** False when the event wasn't for this run (e.g. free text while it waits on a delay). */
  handled: boolean;
  state: RunState;
  effects: Effect[];
  /** The contact with this advance's changes applied. */
  contact: ContactSnapshot;
  /** Steps entered, in order. */
  visited: string[];
};

/** A run that walks this many steps without waiting is assumed to be looping. */
export const MAX_STEPS_PER_ADVANCE = 100;

const HOUR = 3_600_000;
const UNIT_MS = { minutes: 60_000, hours: HOUR, days: 24 * HOUR } as const;
/** How long an AI sort waits for the host before carrying on through "else". */
const ROUTE_TIMEOUT_MS = 10 * 60_000;
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function advance(
  graph: FlowGraph,
  state: RunState | null,
  event: EngineEvent,
  ctx: AdvanceContext,
): AdvanceResult {
  return new Runner(indexGraph(graph), ctx).handle(state, event);
}

class Runner {
  private readonly effects: Effect[] = [];
  private readonly visited: string[] = [];
  private readonly contact: ContactSnapshot;
  private steps = 0;

  constructor(
    private readonly g: GraphIndex,
    private readonly ctx: AdvanceContext,
  ) {
    this.contact = {
      ...ctx.contact,
      tags: [...ctx.contact.tags],
      fields: { ...ctx.contact.fields },
    };
  }

  handle(state: RunState | null, event: EngineEvent): AdvanceResult {
    if (event.type === 'start') {
      if (event.from) return this.done(this.follow(event.from.nodeId, event.from.handle));
      if (!this.g.start)
        return this.done({ status: 'failed', error: 'The automation has no starting step.' });
      return this.done(this.runFrom(this.g.start.id));
    }

    const wait = state?.status === 'waiting' ? state.wait : undefined;
    if (!state || !wait) return this.ignored(state);

    switch (event.type) {
      case 'wake': {
        if (event.token !== wait.token) return this.ignored(state);
        if (wait.kind === 'delay') return this.done(this.follow(wait.nodeId, 'next'));
        // The host never answered the sort: carry on as if nothing matched.
        if (wait.kind === 'route') return this.done(this.routeTo(wait.nodeId));
        // A reply timeout: go down the "timeout" path if one is connected, otherwise expire quietly.
        return this.g.next(wait.nodeId, 'timeout')
          ? this.done(this.follow(wait.nodeId, 'timeout'))
          : this.done({ status: 'expired' });
      }
      case 'choice': {
        if (wait.kind !== 'choice' || event.nodeId !== wait.nodeId) return this.ignored(state);
        const node = this.nodeOf(wait.nodeId, 'message');
        const reply = node?.data.quickReplies.find((q) => q.id === event.handle);
        if (!node || !reply) return this.ignored(state);
        this.saveReply(node, reply.label);
        return this.done(this.follow(node.id, reply.id));
      }
      case 'ai_result': {
        if (wait.kind !== 'ai' || !wait.thinking || event.token !== wait.token)
          return this.ignored(state);
        return this.done(this.aiResult(wait, event));
      }
      case 'ai_route_result': {
        if (wait.kind !== 'route' || event.token !== wait.token) return this.ignored(state);
        return this.done(this.routeTo(wait.nodeId, event.intent));
      }
      case 'message': {
        if (wait.kind === 'ai') return this.done(this.aiMessage(wait));
        // Written while their last message is being sorted: the sort reads it too.
        if (wait.kind === 'route') return this.done(state);
        if (wait.kind === 'input') return this.done(this.answer(wait, event.text));
        if (wait.kind !== 'choice') return this.ignored(state);
        const node = this.nodeOf(wait.nodeId, 'message');
        if (!node) return this.done({ status: 'failed', error: `Step ${wait.nodeId} is missing.` });
        const reply = node.data.quickReplies.find(
          (q) => normalize(q.label) === normalize(event.text),
        );
        if (reply) {
          this.saveReply(node, reply.label);
          return this.done(this.follow(node.id, reply.id));
        }
        if (this.g.next(node.id, 'other')) {
          this.saveReply(node, event.text.trim());
          return this.done(this.follow(node.id, 'other'));
        }
        // Unrecognized text: leave the run waiting (they can still tap) and let the host
        // treat the text as a fresh message (keywords, default reply).
        return this.ignored(state);
      }
    }
  }

  private answer(wait: Extract<RunWait, { kind: 'input' }>, text: string): RunState {
    const node = this.nodeOf(wait.nodeId, 'ask');
    if (!node) return { status: 'failed', error: `Step ${wait.nodeId} is missing.` };
    const value = parseInput(node.data.inputType, text);
    if (value !== null) {
      if (node.data.saveTo) this.setField(node.data.saveTo, value);
      return this.follow(node.id, 'answered');
    }
    if (wait.attempts >= node.data.maxRetries) return this.follow(node.id, 'failed');
    this.send(node.id, [{ type: 'text', text: node.data.retryMessage }]);
    return { status: 'waiting', wait: { ...wait, attempts: wait.attempts + 1 } };
  }

  /** They wrote to an AI step: ask for its next turn (or give up after maxTurns replies). */
  private aiMessage(wait: Extract<RunWait, { kind: 'ai' }>): RunState {
    if (wait.thinking) return { status: 'waiting', wait: { ...wait, missed: true } };
    const node = this.nodeOf(wait.nodeId, 'ai');
    if (!node) return { status: 'failed', error: `Step ${wait.nodeId} is missing.` };
    if (wait.turns >= node.data.maxTurns) return this.follow(node.id, 'gave_up');
    return this.aiTurn(node, wait.turns);
  }

  private aiTurn(node: NodeOf<'ai'>, turns: number): RunState {
    this.effects.push({ type: 'ai_turn', nodeId: node.id });
    return this.waitFor({
      kind: 'ai',
      nodeId: node.id,
      turns,
      thinking: true,
      missed: false,
      until: this.inHours(node.data.timeoutHours),
    });
  }

  private aiResult(
    wait: Extract<RunWait, { kind: 'ai' }>,
    result: Extract<EngineEvent, { type: 'ai_result' }>,
  ): RunState {
    const node = this.nodeOf(wait.nodeId, 'ai');
    if (!node) return { status: 'failed', error: `Step ${wait.nodeId} is missing.` };
    const wanted = new Set(node.data.collect.map((c) => c.key));
    for (const [key, value] of Object.entries(result.fields ?? {}))
      if (wanted.has(key) && value.trim()) this.setField(key, value.trim().slice(0, 500));
    // The AI's words go out as written (no {{templates}}: they're not the flow author's).
    const reply = result.reply?.trim();
    if (reply)
      this.effects.push({
        type: 'send',
        nodeId: node.id,
        message: {
          parts: [{ type: 'text', text: reply.slice(0, 2000) }],
          buttons: [],
          quickReplies: [],
        },
      });
    if (result.outcome === 'done') return this.follow(node.id, 'done');
    if (result.outcome === 'handoff') {
      if (this.g.next(node.id, 'handoff')) return this.follow(node.id, 'handoff');
      this.effects.push({ type: 'handoff', note: 'The AI step asked for a person.' });
      return { status: 'completed' };
    }
    const turns = wait.turns + 1;
    if (wait.missed)
      return turns >= node.data.maxTurns
        ? this.follow(node.id, 'gave_up')
        : this.aiTurn(node, turns);
    return this.waitFor({
      kind: 'ai',
      nodeId: node.id,
      turns,
      thinking: false,
      missed: false,
      until: this.inHours(node.data.timeoutHours),
    });
  }

  /** Leaves an AI sort step through the picked intent, or "else". */
  private routeTo(nodeId: string, intentId?: string): RunState {
    const node = this.nodeOf(nodeId, 'ai_route');
    if (!node) return { status: 'failed', error: `Step ${nodeId} is missing.` };
    const intent = node.data.intents.find((i) => i.id === intentId);
    const key = node.data.saveTo;
    // The field says what their latest message was about, so "else" empties it.
    if (key && intent) this.setField(key, intent.label);
    if (key && !intent && (this.contact.fields[key] ?? '') !== '') {
      this.contact.fields[key] = null;
      this.effects.push({ type: 'clear_field', key });
    }
    return this.follow(node.id, intent ? intent.id : 'else');
  }

  private follow(nodeId: string, handle: string): RunState {
    const target = this.g.next(nodeId, handle);
    return target ? this.runFrom(target) : { status: 'completed' };
  }

  private runFrom(startId: string): RunState {
    let current: string | undefined = startId;
    while (current) {
      if (++this.steps > MAX_STEPS_PER_ADVANCE) {
        return {
          status: 'failed',
          error: `The automation ran ${MAX_STEPS_PER_ADVANCE} steps without pausing, so it was stopped. Check for a loop.`,
        };
      }
      const node = this.g.node(current);
      if (!node) return { status: 'failed', error: `Step ${current} is missing.` };
      this.visited.push(node.id);

      switch (node.type) {
        case 'start':
          current = this.g.next(node.id, 'next');
          break;
        case 'message':
          this.send(node.id, node.data.parts, node.data.buttons, node.data.quickReplies);
          if (node.data.quickReplies.length > 0) {
            return this.waitFor({
              kind: 'choice',
              nodeId: node.id,
              until: this.inHours(node.data.timeoutHours),
            });
          }
          current = this.g.next(node.id, 'next');
          break;
        case 'ask':
          this.send(node.id, [{ type: 'text', text: node.data.question }]);
          return this.waitFor({
            kind: 'input',
            nodeId: node.id,
            attempts: 0,
            until: this.inHours(node.data.timeoutHours),
          });
        case 'condition': {
          const ctx = { contact: this.contact, now: this.ctx.now, timeZone: this.ctx.timeZone };
          const match = node.data.cases.find((c) => evaluateCase(c, ctx));
          current = this.g.next(node.id, match ? match.id : 'else');
          break;
        }
        case 'action':
          for (const a of node.data.actions) this.apply(a);
          current = this.g.next(node.id, 'next');
          break;
        case 'delay': {
          const d = node.data;
          const until =
            d.mode === 'duration'
              ? new Date(this.ctx.now.getTime() + d.amount * UNIT_MS[d.unit])
              : nextTimeOfDay(this.ctx.now, d.time, d.days, this.ctx.timeZone);
          return this.waitFor({ kind: 'delay', nodeId: node.id, until: until.toISOString() });
        }
        case 'split': {
          const total = node.data.branches.reduce((sum, b) => sum + b.weight, 0);
          let roll = (this.ctx.random ?? Math.random)() * total;
          let branch = node.data.branches.at(-1);
          for (const b of node.data.branches) {
            if (roll < b.weight) {
              branch = b;
              break;
            }
            roll -= b.weight;
          }
          current = branch && this.g.next(node.id, branch.id);
          break;
        }
        case 'goto_flow':
          this.effects.push({ type: 'start_flow', flowId: node.data.flowId });
          return { status: 'completed' };
        case 'handoff':
          this.effects.push({ type: 'handoff', note: node.data.note });
          return { status: 'completed' };
        case 'ai':
          return this.aiTurn(node, 0);
        case 'ai_route':
          this.effects.push({ type: 'ai_route', nodeId: node.id });
          return this.waitFor({
            kind: 'route',
            nodeId: node.id,
            until: new Date(this.ctx.now.getTime() + ROUTE_TIMEOUT_MS).toISOString(),
          });
      }
    }
    return { status: 'completed' };
  }

  private apply(a: Action) {
    const hasTag = (tag: string) =>
      this.contact.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
    switch (a.type) {
      case 'add_tag':
        if (!hasTag(a.tag)) {
          this.contact.tags.push(a.tag);
          this.effects.push({ type: 'add_tag', tag: a.tag });
        }
        return;
      case 'remove_tag':
        if (hasTag(a.tag)) {
          this.contact.tags = this.contact.tags.filter(
            (t) => t.toLowerCase() !== a.tag.toLowerCase(),
          );
          this.effects.push({ type: 'remove_tag', tag: a.tag });
        }
        return;
      case 'set_field':
        this.setField(a.key, renderTemplate(a.value, this.contact));
        return;
      case 'clear_field':
        this.contact.fields[a.key] = null;
        this.effects.push({ type: 'clear_field', key: a.key });
        return;
      case 'set_consent':
        this.effects.push({ type: 'set_consent', channel: a.channel, granted: a.granted });
        return;
      case 'notify_team':
        this.effects.push({
          type: 'notify_team',
          message: renderTemplate(a.message, this.contact),
        });
        return;
    }
  }

  private send(
    nodeId: string,
    parts: MessagePart[],
    buttons: Button[] = [],
    quickReplies: QuickReply[] = [],
  ) {
    const c = this.contact;
    this.effects.push({
      type: 'send',
      nodeId,
      message: {
        parts: parts.map((p) => {
          if (p.type === 'text') return { ...p, text: renderTemplate(p.text, c) };
          return { ...p, url: renderUrl(p.url, c) };
        }),
        buttons: buttons.map((b) => (b.kind === 'url' ? { ...b, url: renderUrl(b.url, c) } : b)),
        quickReplies,
      },
    });
  }

  private setField(key: string, value: string | number) {
    this.contact.fields[key] = value;
    this.effects.push({ type: 'set_field', key, value });
  }

  private saveReply(node: NodeOf<'message'>, text: string) {
    if (node.data.saveReplyTo) this.setField(node.data.saveReplyTo, text);
  }

  private waitFor(wait: DistributiveOmit<RunWait, 'token'>): RunState {
    const token = this.ctx.newToken?.() ?? globalThis.crypto.randomUUID();
    return { status: 'waiting', wait: { ...wait, token } as RunWait };
  }

  private inHours(hours: number) {
    return new Date(this.ctx.now.getTime() + hours * HOUR).toISOString();
  }

  private nodeOf<T extends 'message' | 'ask' | 'ai' | 'ai_route'>(id: string, type: T) {
    const node = this.g.node(id);
    return node?.type === type ? (node as NodeOf<T>) : undefined;
  }

  private done(state: RunState): AdvanceResult {
    return {
      handled: true,
      state,
      effects: this.effects,
      contact: this.contact,
      visited: this.visited,
    };
  }

  private ignored(state: RunState | null): AdvanceResult {
    return {
      handled: false,
      state: state ?? { status: 'completed' },
      effects: [],
      contact: this.ctx.contact,
      visited: [],
    };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
