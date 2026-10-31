import type { FlowGraphInput } from './schema';
import type { TriggerConfig } from './triggers';

export type Starter = {
  key: string;
  name: string;
  description: string;
  graph: FlowGraphInput;
  /** A trigger worth creating alongside the flow. */
  trigger?: TriggerConfig;
};

const at = (x: number, y = 0) => ({ x: x * 320, y: y * 220 });
const edge = (source: string, sourceHandle: string, target: string) => ({
  id: `${source}-${sourceHandle}-${target}`,
  source,
  sourceHandle,
  target,
});

export const STARTERS: Starter[] = [
  {
    key: 'lead_magnet',
    name: 'Lead magnet',
    description:
      'Someone comments or DMs a keyword. Ask what they’re interested in, collect their email, and send the resource.',
    trigger: { type: 'keyword', keywords: ['WORKSHOP'], match: 'exact' },
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: at(0) },
        {
          id: 'pick_topic',
          type: 'message',
          position: at(1),
          data: {
            parts: [
              {
                type: 'text',
                text: 'Hey {{first_name | there}}! 🎉 Thanks for your interest in the workshop. Which topic interests you most?',
              },
            ],
            quickReplies: [
              { id: 'topic_basics', label: 'Getting started' },
              { id: 'topic_advanced', label: 'Advanced' },
            ],
            saveReplyTo: 'interest',
          },
        },
        {
          id: 'tag_interest',
          type: 'action',
          position: at(2),
          data: { actions: [{ type: 'add_tag', tag: 'workshop-interest' }] },
        },
        {
          id: 'ask_email',
          type: 'ask',
          position: at(3),
          data: {
            question:
              'Want the free worksheet? Reply with your email and I’ll send it over. We’ll only use it for the worksheet and workshop updates.',
            inputType: 'email',
            saveTo: 'email',
            retryMessage: 'Hmm, that doesn’t look like an email address. Could you try again?',
          },
        },
        {
          id: 'mark_lead',
          type: 'action',
          position: at(4),
          data: {
            actions: [
              { type: 'add_tag', tag: 'lead' },
              { type: 'set_consent', channel: 'email', granted: true },
            ],
          },
        },
        {
          id: 'deliver',
          type: 'message',
          position: at(5),
          data: {
            parts: [
              {
                type: 'text',
                text: 'Here you go, {{first_name | friend}}! 📄 Grab the worksheet, and save your seat while spots last.',
              },
            ],
            buttons: [
              {
                id: 'btn_worksheet',
                kind: 'url',
                label: 'Get the worksheet',
                url: 'https://example.com/worksheet',
              },
              {
                id: 'btn_register',
                kind: 'url',
                label: 'Register',
                url: 'https://example.com/register?email={{email}}',
              },
            ],
          },
        },
        {
          id: 'no_email',
          type: 'message',
          position: at(4, 1),
          data: {
            parts: [
              {
                type: 'text',
                text: 'No problem! Here’s the registration link whenever you’re ready.',
              },
            ],
            buttons: [
              {
                id: 'btn_register_only',
                kind: 'url',
                label: 'Register',
                url: 'https://example.com/register',
              },
            ],
          },
        },
      ],
      edges: [
        edge('start', 'next', 'pick_topic'),
        edge('pick_topic', 'topic_basics', 'tag_interest'),
        edge('pick_topic', 'topic_advanced', 'tag_interest'),
        edge('pick_topic', 'other', 'tag_interest'),
        edge('tag_interest', 'next', 'ask_email'),
        edge('ask_email', 'answered', 'mark_lead'),
        edge('ask_email', 'failed', 'no_email'),
        edge('mark_lead', 'next', 'deliver'),
      ],
    },
  },
  {
    key: 'welcome',
    name: 'Welcome message',
    description: 'Greet new people, point them to answers, and hand off to a person when they ask.',
    trigger: { type: 'welcome' },
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: at(0) },
        {
          id: 'greet',
          type: 'message',
          position: at(1),
          data: {
            parts: [
              {
                type: 'text',
                text: 'Hi {{first_name | there}}, thanks for reaching out! How can we help?',
              },
            ],
            quickReplies: [
              { id: 'qr_pricing', label: 'Pricing' },
              { id: 'qr_person', label: 'Talk to a person' },
            ],
          },
        },
        {
          id: 'pricing',
          type: 'message',
          position: at(2),
          data: {
            parts: [{ type: 'text', text: 'Here’s everything on pricing 👇' }],
            buttons: [
              {
                id: 'btn_pricing',
                kind: 'url',
                label: 'See pricing',
                url: 'https://example.com/pricing',
              },
            ],
          },
        },
        {
          id: 'reassure',
          type: 'message',
          position: at(2, 1),
          data: {
            parts: [
              { type: 'text', text: 'Got it. Someone from the team will reply right here soon.' },
            ],
          },
        },
        {
          id: 'alert_team',
          type: 'action',
          position: at(3, 1),
          data: {
            actions: [
              {
                type: 'notify_team',
                message: '{{full_name | Someone}} asked to talk to a person.',
              },
            ],
          },
        },
        {
          id: 'to_human',
          type: 'handoff',
          position: at(4, 1),
          data: { note: 'Asked to talk to a person' },
        },
      ],
      edges: [
        edge('start', 'next', 'greet'),
        edge('greet', 'qr_pricing', 'pricing'),
        edge('greet', 'qr_person', 'reassure'),
        edge('reassure', 'next', 'alert_team'),
        edge('alert_team', 'next', 'to_human'),
      ],
    },
  },
  {
    key: 'keyword_reply',
    name: 'Keyword reply',
    description: 'Reply to a keyword with a link, and tag who asked.',
    trigger: { type: 'keyword', keywords: ['GUIDE'], match: 'exact' },
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: at(0) },
        {
          id: 'send_link',
          type: 'message',
          position: at(1),
          data: {
            parts: [{ type: 'text', text: 'Here’s the guide you asked for 👇' }],
            buttons: [
              {
                id: 'btn_guide',
                kind: 'url',
                label: 'Get the guide',
                url: 'https://example.com/guide',
              },
            ],
          },
        },
        {
          id: 'tag',
          type: 'action',
          position: at(2),
          data: { actions: [{ type: 'add_tag', tag: 'guide-requested' }] },
        },
      ],
      edges: [edge('start', 'next', 'send_link'), edge('send_link', 'next', 'tag')],
    },
  },
  {
    key: 'blank',
    name: 'Blank flow',
    description: 'Start from an empty canvas.',
    graph: { nodes: [{ id: 'start', type: 'start', position: at(0) }], edges: [] },
  },
];
