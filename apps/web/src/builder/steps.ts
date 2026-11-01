import {
  ArrowBendUpRight,
  ArrowsSplit,
  ChatText,
  Clock,
  GitBranch,
  Handshake,
  Lightning,
  type Icon as PhosphorIcon,
  Play,
  Question,
  Signpost,
  Sparkle,
} from '@phosphor-icons/react';
import type { ConditionRule, FlowNode, FlowNodeType, NodeOf } from '@social-switchboard/flow';

// What the builder knows about each step type: how it's named, drawn, created and summarized.

export const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

export const STEP_META: Record<FlowNodeType, { label: string; icon: PhosphorIcon; blurb: string }> =
  {
    start: { label: 'Start', icon: Play, blurb: 'Where the flow begins' },
    message: {
      label: 'Message',
      icon: ChatText,
      blurb: 'Send text, images, links and quick replies',
    },
    ask: { label: 'Ask', icon: Question, blurb: 'Ask a question and save the answer' },
    condition: {
      label: 'Condition',
      icon: GitBranch,
      blurb: 'Branch on tags, fields, channel or time',
    },
    action: {
      label: 'Actions',
      icon: Lightning,
      blurb: 'Tag, set fields, record consent, alert the team',
    },
    delay: { label: 'Delay', icon: Clock, blurb: 'Wait a while, or until a time of day' },
    split: { label: 'A/B split', icon: ArrowsSplit, blurb: 'Send people down paths at random' },
    goto_flow: { label: 'Go to flow', icon: ArrowBendUpRight, blurb: 'Continue in another flow' },
    handoff: {
      label: 'Hand off',
      icon: Handshake,
      blurb: 'Pause automation so a person can reply',
    },
    ai: {
      label: 'AI conversation',
      icon: Sparkle,
      blurb: 'Let AI talk toward a goal and collect details',
    },
    ai_route: {
      label: 'AI sort',
      icon: Signpost,
      blurb: 'Branch on what their message is asking for',
    },
  };

export const ADDABLE: FlowNodeType[] = [
  'message',
  'ask',
  'ai',
  'ai_route',
  'condition',
  'action',
  'delay',
  'split',
  'goto_flow',
  'handoff',
];

export function defaultStep(type: FlowNodeType, position: { x: number; y: number }): FlowNode {
  const id = newId(type);
  switch (type) {
    case 'start':
      return { id, type, position, data: {} };
    case 'message':
      return {
        id,
        type,
        position,
        data: {
          parts: [{ type: 'text', text: 'New message' }],
          buttons: [],
          quickReplies: [],
          timeoutHours: 24,
        },
      };
    case 'ask':
      return {
        id,
        type,
        position,
        data: {
          question: 'What’s your email?',
          inputType: 'email',
          saveTo: 'email',
          retryMessage: 'That doesn’t look right. Please try again.',
          maxRetries: 2,
          timeoutHours: 24,
        },
      };
    case 'condition':
      return {
        id,
        type,
        position,
        data: {
          cases: [
            {
              id: newId('case'),
              match: 'all',
              rules: [{ subject: 'tag', op: 'has', tag: 'lead' }],
            },
          ],
        },
      };
    case 'action':
      return { id, type, position, data: { actions: [{ type: 'add_tag', tag: 'new-tag' }] } };
    case 'delay':
      return { id, type, position, data: { mode: 'duration', amount: 1, unit: 'hours' } };
    case 'split':
      return {
        id,
        type,
        position,
        data: {
          branches: [
            { id: newId('a'), label: 'A', weight: 50 },
            { id: newId('b'), label: 'B', weight: 50 },
          ],
        },
      };
    case 'goto_flow':
      return { id, type, position, data: { flowId: 'choose' } };
    case 'handoff':
      return { id, type, position, data: { note: '' } };
    case 'ai':
      return {
        id,
        type,
        position,
        data: {
          goal: 'Answer their questions and find out what they need',
          instructions: '',
          collect: [],
          maxTurns: 6,
          timeoutHours: 24,
        },
      };
    case 'ai_route':
      return {
        id,
        type,
        position,
        data: {
          intents: [
            { id: newId('intent'), label: 'Pricing', description: 'asks what something costs' },
            {
              id: newId('intent'),
              label: 'Booking',
              description: 'wants to book or change a time',
            },
          ],
        },
      };
  }
}

export function ruleText(r: ConditionRule): string {
  switch (r.subject) {
    case 'tag':
      return `${r.op === 'has' ? 'has' : 'doesn’t have'} tag “${r.tag}”`;
    case 'field': {
      const ops: Record<typeof r.op, string> = {
        is_set: 'is set',
        is_not_set: 'is empty',
        equals: `is “${r.value}”`,
        not_equals: `isn’t “${r.value}”`,
        contains: `contains “${r.value}”`,
        not_contains: `doesn’t contain “${r.value}”`,
        greater_than: `> ${r.value}`,
        less_than: `< ${r.value}`,
      };
      return `${r.key} ${ops[r.op]}`;
    }
    case 'channel':
      return `channel ${r.op === 'is' ? 'is' : 'isn’t'} ${r.value}`;
    case 'weekday':
      return `on ${r.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}`;
    case 'hour':
      return `between ${r.from}:00 and ${r.to}:00`;
  }
}

/** Every output handle with a human label, in the same order as outputHandles(). */
export function handleLabels(node: FlowNode): { id: string; label: string }[] {
  switch (node.type) {
    case 'start':
    case 'action':
    case 'delay':
      return [{ id: 'next', label: 'Then' }];
    case 'message': {
      const flowButtons = node.data.buttons.flatMap((b) =>
        b.kind === 'flow' ? [{ id: b.id, label: `Tapped “${b.label}”` }] : [],
      );
      return node.data.quickReplies.length > 0
        ? [
            ...node.data.quickReplies.map((q) => ({ id: q.id, label: q.label })),
            { id: 'other', label: 'Typed something else' },
            { id: 'timeout', label: 'No reply' },
            ...flowButtons,
          ]
        : [{ id: 'next', label: 'Then' }, ...flowButtons];
    }
    case 'ask':
      return [
        { id: 'answered', label: 'Valid answer' },
        { id: 'failed', label: 'Gave up' },
        { id: 'timeout', label: 'No reply' },
      ];
    case 'condition':
      return [
        ...node.data.cases.map((c, i) => ({
          id: c.id,
          label: `${i + 1}. ${c.rules.map(ruleText).join(c.match === 'all' ? ' and ' : ' or ')}`,
        })),
        { id: 'else', label: 'Otherwise' },
      ];
    case 'split': {
      const total = node.data.branches.reduce((s, b) => s + b.weight, 0) || 1;
      return node.data.branches.map((b) => ({
        id: b.id,
        label: `${b.label} · ${Math.round((b.weight / total) * 100)}%`,
      }));
    }
    case 'ai':
      return [
        { id: 'done', label: 'Goal met' },
        { id: 'handoff', label: 'Needs a person' },
        { id: 'gave_up', label: 'Didn’t get there' },
        { id: 'timeout', label: 'No reply' },
      ];
    case 'ai_route':
      return [
        ...node.data.intents.map((i) => ({ id: i.id, label: i.label })),
        { id: 'else', label: 'None of these' },
      ];
    case 'goto_flow':
    case 'handoff':
      return [];
  }
}

export function summarize(node: FlowNode, flowName: (id: string) => string | undefined): string {
  switch (node.type) {
    case 'start':
      return '';
    case 'message': {
      const first = node.data.parts[0];
      const text =
        first?.type === 'text'
          ? first.text
          : first?.type === 'image'
            ? '🖼 Image'
            : `📄 ${first?.name ?? ''}`;
      const links = node.data.buttons.filter((b) => b.kind === 'url').map((b) => `🔗 ${b.label}`);
      return [text, ...links].join('\n');
    }
    case 'ask':
      return `${node.data.question}\n→ ${node.data.inputType}${node.data.saveTo ? ` saved to {{${node.data.saveTo}}}` : ''}`;
    case 'condition':
      return `${node.data.cases.length} case${node.data.cases.length === 1 ? '' : 's'}, checked in order`;
    case 'action':
      return node.data.actions.map(actionText).join('\n');
    case 'delay':
      return node.data.mode === 'duration'
        ? `Wait ${node.data.amount} ${node.data.amount === 1 ? node.data.unit.replace(/s$/, '') : node.data.unit}`
        : `Wait until ${node.data.time}${node.data.days.length ? ` on ${node.data.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}` : ''}`;
    case 'split':
      return 'Random, by weight';
    case 'goto_flow':
      return `→ ${flowName(node.data.flowId) ?? 'Choose a flow'}`;
    case 'handoff':
      return node.data.note || 'Automation pauses until someone resumes it';
    case 'ai':
      return `${node.data.goal}${node.data.collect.length ? `\n→ collects ${node.data.collect.map((c) => `{{${c.key}}}`).join(', ')}` : ''}`;
    case 'ai_route':
      return `What is their message asking for?${node.data.saveTo ? `\n→ saved to {{${node.data.saveTo}}}` : ''}`;
  }
}

export function actionText(a: NodeOf<'action'>['data']['actions'][number]) {
  switch (a.type) {
    case 'add_tag':
      return `+ tag “${a.tag}”`;
    case 'remove_tag':
      return `− tag “${a.tag}”`;
    case 'set_field':
      return `${a.key} = ${a.value}`;
    case 'clear_field':
      return `clear ${a.key}`;
    case 'set_consent':
      return `${a.channel} consent: ${a.granted ? 'yes' : 'no'}`;
    case 'notify_team':
      return `Notify team: ${a.message}`;
  }
}
