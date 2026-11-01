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

/** Stands in for the account's Instagram username in a starter; filled in when the flow is made. */
export const HANDLE_PLACEHOLDER = 'your_handle';

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
      'Send the resource the moment someone comments or DMs a keyword. A “Send me more” tap brings in their name, photo and email.',
    trigger: { type: 'keyword', keywords: ['WORKSHOP'], match: 'exact' },
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: at(0) },
        {
          // The resource goes out at once. The tap is what makes them a lead: it tells Instagram
          // they're talking to you, so their name and photo come in, and you can message them
          // again (after a comment, one message is all you get until they do).
          id: 'deliver',
          type: 'message',
          position: at(1),
          data: {
            parts: [
              {
                type: 'text',
                text: 'Here’s your free worksheet 📄 Want more like it, and first word when the next workshop opens? Tap “Send me more”.',
              },
            ],
            buttons: [
              {
                id: 'btn_worksheet',
                kind: 'url',
                label: 'Get the worksheet',
                url: 'https://example.com/worksheet',
              },
              { id: 'btn_more', kind: 'flow', label: 'Send me more' },
            ],
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
              'Love it, {{first_name | friend}}! What’s your email? I’ll send new worksheets and workshop dates there, and nothing else.',
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
          id: 'on_the_list',
          type: 'message',
          position: at(5),
          data: {
            parts: [
              {
                type: 'text',
                text: 'You’re on the list, {{first_name | friend}}! 🎉 Save your seat for the next workshop while spots last.',
              },
            ],
            buttons: [
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
        edge('start', 'next', 'deliver'),
        edge('deliver', 'btn_more', 'tag_interest'),
        edge('tag_interest', 'next', 'ask_email'),
        edge('ask_email', 'answered', 'mark_lead'),
        edge('ask_email', 'failed', 'no_email'),
        edge('mark_lead', 'next', 'on_the_list'),
      ],
    },
  },
  {
    key: 'follow_first',
    name: 'Follow first',
    description:
      'Someone comments a keyword. Check they follow you before the link goes out, with a nudge to follow if they don’t yet.',
    trigger: {
      type: 'comment',
      keywords: ['GUIDE'],
      match: 'contains',
      mediaIds: [],
      publicReplies: ['Sent you a DM 💌'],
    },
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: at(0) },
        {
          // After a comment Instagram doesn't say yet whether they follow (that takes a message or
          // a tap), so a commenter lands on the nudge, and their tap is the real check.
          id: 'check',
          type: 'condition',
          position: at(1),
          data: {
            cases: [{ id: 'follows', match: 'all', rules: [{ subject: 'follows', op: 'yes' }] }],
          },
        },
        {
          id: 'ask_follow',
          type: 'message',
          position: at(2, 1),
          data: {
            parts: [
              {
                type: 'text',
                text: 'This one’s for my followers 💛 Make sure you’re following me, then tap “I’m following” and I’ll send it right over.',
              },
            ],
            buttons: [
              {
                id: 'btn_follow',
                kind: 'url',
                label: 'Follow me',
                url: `https://www.instagram.com/${HANDLE_PLACEHOLDER}`,
              },
              { id: 'btn_following', kind: 'flow', label: 'I’m following' },
            ],
          },
        },
        {
          id: 'recheck',
          type: 'condition',
          position: at(3, 1),
          data: {
            cases: [{ id: 'follows', match: 'all', rules: [{ subject: 'follows', op: 'yes' }] }],
          },
        },
        {
          id: 'not_yet',
          type: 'message',
          position: at(4, 2),
          data: {
            parts: [
              {
                type: 'text',
                text: 'Hmm, I don’t see the follow yet 👀 Tap “Follow me”, follow, then tap “I’m following” again.',
              },
            ],
            buttons: [
              {
                id: 'btn_follow_again',
                kind: 'url',
                label: 'Follow me',
                url: `https://www.instagram.com/${HANDLE_PLACEHOLDER}`,
              },
              { id: 'btn_following_again', kind: 'flow', label: 'I’m following' },
            ],
          },
        },
        {
          id: 'send',
          type: 'message',
          position: at(4),
          data: {
            parts: [
              { type: 'text', text: 'Thanks for following! 💛 Here’s the guide you asked for 👇' },
            ],
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
          position: at(5),
          data: { actions: [{ type: 'add_tag', tag: 'guide-sent' }] },
        },
      ],
      edges: [
        edge('start', 'next', 'check'),
        edge('check', 'follows', 'send'),
        edge('check', 'else', 'ask_follow'),
        edge('ask_follow', 'btn_following', 'recheck'),
        edge('recheck', 'follows', 'send'),
        edge('recheck', 'else', 'not_yet'),
        edge('not_yet', 'btn_following_again', 'recheck'),
        edge('send', 'next', 'tag'),
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
