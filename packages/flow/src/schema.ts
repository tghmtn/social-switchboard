import { z } from 'zod';

// A flow is a graph in React Flow's shape: typed nodes plus edges that leave a node through a
// named output handle ("next", a button id, a condition case id, ...). The builder edits this
// shape directly and the engine walks it, so the same schema serves both.

// Ids end up inside button payloads that channels echo back, so keep them to a safe alphabet.
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use letters, numbers, _ and -');
const position = z.object({ x: z.number(), y: z.number() });

/** Custom field keys: lowercase snake_case. System keys (email, phone, ...) use the same space. */
export const fieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, numbers and _');
export const tagName = z.string().trim().min(1).max(50);

/** Contact properties that live on the contact itself rather than in custom fields. */
export const SYSTEM_FIELDS = ['first_name', 'last_name', 'email', 'phone'] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

// Instagram caps button and quick-reply titles at 20 characters; we use that everywhere.
const label = z.string().trim().min(1).max(20);
const timeoutHours = z
  .number()
  .positive()
  .max(24 * 30)
  .default(24);

export const messagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(2000) }),
  z.object({
    type: z.literal('image'),
    url: z.string().min(1).max(2000),
    alt: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('file'),
    url: z.string().min(1).max(2000),
    name: z.string().min(1).max(200),
  }),
]);

export const button = z.discriminatedUnion('kind', [
  /** Opens a link. The URL may contain {{variables}}. */
  z.object({ id, kind: z.literal('url'), label, url: z.string().min(1).max(2000) }),
  /** Continues the flow through the edge leaving this button's handle, whenever it's tapped. */
  z.object({ id, kind: z.literal('flow'), label }),
]);

export const quickReply = z.object({ id, label });

export const conditionRule = z.discriminatedUnion('subject', [
  z.object({ subject: z.literal('tag'), op: z.enum(['has', 'not_has']), tag: tagName }),
  z.object({
    subject: z.literal('field'),
    key: fieldKey,
    op: z.enum([
      'is_set',
      'is_not_set',
      'equals',
      'not_equals',
      'contains',
      'not_contains',
      'greater_than',
      'less_than',
    ]),
    value: z.string().max(500).default(''),
  }),
  z.object({
    subject: z.literal('channel'),
    op: z.enum(['is', 'is_not']),
    value: z.string().min(1),
  }),
  /** Day of week in the workspace time zone, 0 = Sunday. */
  z.object({
    subject: z.literal('weekday'),
    op: z.literal('in'),
    days: z.array(z.number().int().min(0).max(6)).min(1),
  }),
  /** Hour of day in the workspace time zone; `to` is exclusive, and from > to wraps past midnight. */
  z.object({
    subject: z.literal('hour'),
    op: z.literal('between'),
    from: z.number().int().min(0).max(23),
    to: z.number().int().min(0).max(24),
  }),
]);

export const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag: tagName }),
  z.object({ type: z.literal('remove_tag'), tag: tagName }),
  /** The value may contain {{variables}}. */
  z.object({ type: z.literal('set_field'), key: fieldKey, value: z.string().max(2000) }),
  z.object({ type: z.literal('clear_field'), key: fieldKey }),
  /** Records opt-in or opt-out for follow-ups on another channel. */
  z.object({
    type: z.literal('set_consent'),
    channel: z.enum(['email', 'sms']),
    granted: z.boolean(),
  }),
  z.object({ type: z.literal('notify_team'), message: z.string().trim().min(1).max(500) }),
]);

const base = { id, position: position.default({ x: 0, y: 0 }) };

export const flowNode = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('start'), data: z.object({}).default({}) }),
  z.object({
    ...base,
    type: z.literal('message'),
    data: z.object({
      parts: z.array(messagePart).min(1).max(10),
      buttons: z.array(button).max(3).default([]),
      /** When present, the run waits here for the contact to pick one. */
      quickReplies: z.array(quickReply).max(13).default([]),
      /** Saves the picked quick reply's label into this field. */
      saveReplyTo: fieldKey.optional(),
      timeoutHours,
    }),
  }),
  z.object({
    ...base,
    type: z.literal('ask'),
    data: z.object({
      question: z.string().trim().min(1).max(2000),
      inputType: z.enum(['text', 'email', 'phone', 'number', 'url']),
      saveTo: fieldKey.optional(),
      retryMessage: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .default('That doesn’t look right. Please try again.'),
      maxRetries: z.number().int().min(0).max(5).default(2),
      timeoutHours,
    }),
  }),
  z.object({
    ...base,
    type: z.literal('condition'),
    data: z.object({
      /** Checked in order; the first matching case wins, otherwise "else". */
      cases: z
        .array(
          z.object({
            id,
            match: z.enum(['all', 'any']).default('all'),
            rules: z.array(conditionRule).min(1).max(20),
          }),
        )
        .min(1)
        .max(10),
    }),
  }),
  z.object({
    ...base,
    type: z.literal('action'),
    data: z.object({ actions: z.array(action).min(1).max(20) }),
  }),
  z.object({
    ...base,
    type: z.literal('delay'),
    data: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('duration'),
        amount: z.number().int().min(1).max(999),
        unit: z.enum(['minutes', 'hours', 'days']),
      }),
      /** Waits until the next HH:MM (workspace time zone), optionally only on certain weekdays. */
      z.object({
        mode: z.literal('until_time'),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        days: z.array(z.number().int().min(0).max(6)).default([]),
      }),
    ]),
  }),
  z.object({
    ...base,
    type: z.literal('split'),
    data: z.object({
      branches: z
        .array(
          z.object({
            id,
            label: z.string().trim().min(1).max(40),
            weight: z.number().int().min(1).max(100),
          }),
        )
        .min(2)
        .max(5),
    }),
  }),
  z.object({ ...base, type: z.literal('goto_flow'), data: z.object({ flowId: id }) }),
  /** Pauses automation for this contact so a person can take over. */
  z.object({
    ...base,
    type: z.literal('handoff'),
    data: z.object({ note: z.string().max(500).optional() }),
  }),
  /**
   * A conversation run by AI toward a goal: it replies, collects fields, and leaves through
   * "done" (goal met), "handoff" (a person should take over), "gave_up" (maxTurns replies
   * without getting there) or "timeout" (they stopped answering). Needs the workspace's AI key.
   */
  z.object({
    ...base,
    type: z.literal('ai'),
    data: z.object({
      goal: z.string().trim().min(1).max(1000),
      /** Business facts, tone and rules the AI should follow. */
      instructions: z.string().max(8000).default(''),
      /** Contact fields to fill in from what they say. */
      collect: z
        .array(z.object({ key: fieldKey, description: z.string().trim().max(200).default('') }))
        .max(10)
        .default([]),
      maxTurns: z.number().int().min(1).max(20).default(6),
      timeoutHours,
    }),
  }),
]);

// Edge ids never leave the graph, so any reasonable string will do (React Flow makes its own).
export const flowEdge = z.object({
  id: z.string().min(1).max(200),
  source: id,
  sourceHandle: id,
  target: id,
});

export const flowGraph = z.object({
  nodes: z.array(flowNode).max(500),
  edges: z.array(flowEdge).max(2000),
});

export type MessagePart = z.infer<typeof messagePart>;
export type Button = z.infer<typeof button>;
export type QuickReply = z.infer<typeof quickReply>;
export type ConditionRule = z.infer<typeof conditionRule>;
export type Action = z.infer<typeof action>;
export type FlowNode = z.infer<typeof flowNode>;
export type FlowNodeType = FlowNode['type'];
export type FlowEdge = z.infer<typeof flowEdge>;
export type FlowGraph = z.infer<typeof flowGraph>;
/** What the builder may send: defaults not yet applied. */
export type FlowGraphInput = z.input<typeof flowGraph>;
export type NodeOf<T extends FlowNodeType> = Extract<FlowNode, { type: T }>;
