import { and, eq, isNotNull } from 'drizzle-orm';
import { decryptSecret } from './crypto';
import type { Db } from './db/client';
import { contactIdentities, contacts, workspaces } from './db/schema';

// Push notifications through ntfy (ntfy.sh, or a self-hosted server): a phone buzzes when a
// conversation needs a person. Best effort and never in the way of handling the message.

export type Notice = {
  workspaceId: string;
  contactId: string;
  channel: string;
  /**
   * paused: they wrote while the bot is paused. handoff: a flow handed them to a person.
   * team: a flow's "notify the team" step. unanswered: a DM nothing answered.
   */
  kind: 'paused' | 'handoff' | 'team' | 'unanswered';
  text?: string;
};

/** One push per contact and kind in this window, so a chatty conversation doesn't buzz nonstop. */
const QUIET_MS = 10 * 60_000;
const lastSent = new Map<string, number>();

/** Swappable for tests. */
let http: typeof fetch = (...args) => fetch(...args);
export function setNotifyHttp(impl: typeof fetch) {
  http = impl;
}

/** Splits an ntfy topic URL into the server (for JSON publishing) and the topic. */
export function ntfyTarget(url: string) {
  const u = new URL(url);
  const topic = u.pathname.split('/').filter(Boolean).pop();
  if (!topic || !/^[\w-]{1,64}$/.test(topic)) return undefined;
  return { server: `${u.origin}${u.pathname.slice(0, u.pathname.lastIndexOf('/'))}`, topic };
}

/** Publishes one message to an ntfy topic. Throws on failure (the test button shows why). */
export async function publish(
  target: { url: string; token?: string },
  message: { title: string; text: string; click?: string; priority?: number; tags?: string[] },
) {
  const t = ntfyTarget(target.url);
  if (!t) throw new Error('That isn’t an ntfy topic URL, like https://ntfy.sh/my-topic.');
  const res = await http(t.server || target.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
    },
    body: JSON.stringify({
      topic: t.topic,
      title: message.title,
      message: message.text,
      click: message.click,
      priority: message.priority,
      tags: message.tags,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok)
    throw new Error(
      `ntfy answered ${res.status}${res.status === 403 ? ' (check the token)' : ''}.`,
    );
}

/** The runtime's notify hook: looks up who it's about and where to send it, then pushes. */
export function notifier(deps: {
  db: Db;
  appSecret: string;
  publicUrl: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}) {
  return (n: Notice) => {
    if (n.channel === 'simulator') return;
    const key = `${n.contactId}:${n.kind}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < QUIET_MS) return;
    lastSent.set(key, now);
    void send(deps, n).catch((err: unknown) =>
      deps.log?.('notification failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  };
}

async function send(deps: { db: Db; appSecret: string; publicUrl: string }, n: Notice) {
  const [ws] = await deps.db
    .select({ url: workspaces.notifyUrl, tokenEnc: workspaces.notifyTokenEnc })
    .from(workspaces)
    .where(and(eq(workspaces.id, n.workspaceId), isNotNull(workspaces.notifyUrl)));
  if (!ws?.url) return;
  const [c] = await deps.db
    .select({ first: contacts.firstName, last: contacts.lastName })
    .from(contacts)
    .where(eq(contacts.id, n.contactId));
  const [identity] = await deps.db
    .select({ username: contactIdentities.username })
    .from(contactIdentities)
    .where(and(eq(contactIdentities.contactId, n.contactId), isNotNull(contactIdentities.username)))
    .limit(1);
  const name =
    [c?.first, c?.last].filter(Boolean).join(' ') ||
    (identity?.username ? `@${identity.username}` : 'Someone');
  const title = {
    paused: `${name} wrote (bot paused)`,
    handoff: `${name} needs a person`,
    team: `About ${name}`,
    unanswered: `${name} sent a message`,
  }[n.kind];
  await publish(
    {
      url: ws.url,
      token: ws.tokenEnc ? decryptSecret(deps.appSecret, ws.tokenEnc) : undefined,
    },
    {
      title,
      text: (n.text || 'Open the inbox to see it.').slice(0, 300),
      click: `${deps.publicUrl}/inbox/${n.contactId}`,
      priority: n.kind === 'handoff' ? 4 : 3,
      tags: [n.kind === 'handoff' ? 'raising_hand' : 'speech_balloon'],
    },
  );
}
