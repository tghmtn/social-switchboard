import { and, eq, isNotNull } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { decryptSecret } from './crypto';
import type { Db } from './db/client';
import {
  type AlertChannel,
  contactIdentities,
  contacts,
  type NoticeKind,
  notificationPrefs,
  type SmtpSettings,
  type TwilioSettings,
  users,
  workspaceMembers,
  workspaces,
} from './db/schema';

// Alerts when a conversation needs someone. Admins set up the senders (ntfy push, email over
// SMTP, Twilio texts, plus an optional shared team topic); each teammate picks which events reach
// them and how. Best effort, and never in the way of handling the message.

export type Notice = {
  workspaceId: string;
  contactId: string;
  channel: string;
  kind: NoticeKind;
  text?: string;
  /** For "assigned": the teammate it's for. */
  userId?: string;
};

export const NOTICE_INFO: Record<NoticeKind, { label: string; help: string }> = {
  handoff: { label: 'Needs a person', help: 'A flow or the AI handed a conversation to the team.' },
  assigned: { label: 'Assigned to me', help: 'A teammate gave you a conversation.' },
  team: { label: 'Alerts from flows', help: 'A flow’s “notify the team” step.' },
  unanswered: { label: 'Unanswered messages', help: 'A DM no flow answered.' },
  paused: {
    label: 'Messages while the bot is paused',
    help: 'Someone wrote while the bot was paused for them.',
  },
};

/**
 * What a teammate gets until they choose: what needs someone by push and email, the rest by push.
 * Never texts, which cost money per message.
 */
export const DEFAULT_EVENTS: Record<NoticeKind, AlertChannel[]> = {
  handoff: ['push', 'email'],
  assigned: ['push', 'email'],
  team: ['push', 'email'],
  unanswered: ['push'],
  paused: ['push'],
};

/** One alert per contact and kind in this window, so a chatty conversation doesn't buzz nonstop. */
const QUIET_MS = 10 * 60_000;
const lastSent = new Map<string, number>();

/** Swappable for tests (ntfy and Twilio). */
let http: typeof fetch = (...args) => fetch(...args);
export function setNotifyHttp(impl: typeof fetch) {
  http = impl;
}

// ------------------------------------------------------------------ push (ntfy)

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

// ------------------------------------------------------------------ email (SMTP)

export type Mail = { to: string; subject: string; text: string; html?: string };
type Mailer = (smtp: SmtpSettings & { password?: string }, mail: Mail) => Promise<void>;

let mailer: Mailer = async (smtp, mail) => {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls',
    ignoreTLS: smtp.security === 'none',
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  await transport.sendMail({
    from: smtp.fromName ? { name: smtp.fromName, address: smtp.from } : smtp.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
};
/** Swappable for tests. */
export function setMailer(m: Mailer) {
  mailer = m;
}
export const sendEmail = (smtp: SmtpSettings & { password?: string }, mail: Mail) =>
  mailer(smtp, mail);

// ------------------------------------------------------------------ texts (Twilio)

/** Sends one text through Twilio. `from` is a phone number, or a Messaging Service SID (MG…). */
export async function sendSms(
  twilio: TwilioSettings & { token: string },
  to: string,
  body: string,
) {
  const res = await http(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        Body: body,
        ...(twilio.from.startsWith('MG')
          ? { MessagingServiceSid: twilio.from }
          : { From: twilio.from }),
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(`Twilio answered ${res.status}${j?.message ? `: ${j.message}` : '.'}`);
  }
}

// ------------------------------------------------------------------ routing

type Deps = {
  db: Db;
  appSecret: string;
  publicUrl: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
};

/** A workspace's senders, secrets decrypted. */
export async function senders(db: Db, appSecret: string, workspaceId: string) {
  const [ws] = await db
    .select({
      teamUrl: workspaces.notifyUrl,
      teamTokenEnc: workspaces.notifyTokenEnc,
      smtp: workspaces.smtp,
      smtpPassEnc: workspaces.smtpPassEnc,
      twilio: workspaces.twilio,
      twilioTokenEnc: workspaces.twilioTokenEnc,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const dec = (enc: string | null | undefined) => (enc ? decryptSecret(appSecret, enc) : undefined);
  return {
    team: ws?.teamUrl ? { url: ws.teamUrl, token: dec(ws.teamTokenEnc) } : undefined,
    smtp: ws?.smtp ? { ...ws.smtp, password: dec(ws.smtpPassEnc) } : undefined,
    twilio:
      ws?.twilio && ws.twilioTokenEnc
        ? { ...ws.twilio, token: dec(ws.twilioTokenEnc) ?? '' }
        : undefined,
  };
}

/** Each teammate's addresses and choices (defaults filled in). */
export async function recipients(db: Db, appSecret: string, workspaceId: string) {
  const rows = await db
    .select({
      userId: workspaceMembers.userId,
      accountEmail: users.email,
      pushUrl: notificationPrefs.pushUrl,
      pushTokenEnc: notificationPrefs.pushTokenEnc,
      email: notificationPrefs.email,
      phone: notificationPrefs.phone,
      events: notificationPrefs.events,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .leftJoin(
      notificationPrefs,
      and(
        eq(notificationPrefs.workspaceId, workspaceMembers.workspaceId),
        eq(notificationPrefs.userId, workspaceMembers.userId),
      ),
    )
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return rows.map((r) => ({
    userId: r.userId,
    push: r.pushUrl
      ? {
          url: r.pushUrl,
          token: r.pushTokenEnc ? decryptSecret(appSecret, r.pushTokenEnc) : undefined,
        }
      : undefined,
    email: r.email || r.accountEmail,
    phone: r.phone ?? undefined,
    events: { ...DEFAULT_EVENTS, ...(r.events ?? {}) },
  }));
}

/** The runtime's notify hook: works out who wants this and how, then sends. */
export function notifier(deps: Deps) {
  return (n: Notice) => {
    if (n.channel === 'simulator') return;
    const key = `${n.contactId}:${n.kind}:${n.userId ?? ''}`;
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

async function send(deps: Deps, n: Notice) {
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
    assigned: `${name} is yours`,
  }[n.kind];
  const text = (n.text || 'Open the inbox to see it.').slice(0, 300);
  const link = `${deps.publicUrl}/inbox/${n.contactId}`;

  const from = await senders(deps.db, deps.appSecret, n.workspaceId);
  const jobs: { to: string; job: Promise<void> }[] = [];
  const push = (target: { url: string; token?: string }) =>
    publish(target, {
      title,
      text,
      click: link,
      priority: n.kind === 'handoff' || n.kind === 'assigned' ? 4 : 3,
      tags: [n.kind === 'handoff' ? 'raising_hand' : 'speech_balloon'],
    });

  // The shared team topic hears everything but personal assignments.
  if (from.team && n.kind !== 'assigned') jobs.push({ to: 'team topic', job: push(from.team) });

  for (const r of await recipients(deps.db, deps.appSecret, n.workspaceId)) {
    if (n.kind === 'assigned' && r.userId !== n.userId) continue;
    const ways = r.events[n.kind] ?? [];
    if (ways.includes('push') && r.push) jobs.push({ to: 'push', job: push(r.push) });
    if (ways.includes('email') && from.smtp && r.email)
      jobs.push({
        to: 'email',
        job: sendEmail(from.smtp, alertEmail(r.email, title, text, link, deps.publicUrl)),
      });
    if (ways.includes('sms') && from.twilio && r.phone)
      jobs.push({
        to: 'text',
        job: sendSms(from.twilio, r.phone, `${`${title}: ${text}`.slice(0, 280)}\n${link}`),
      });
  }
  const results = await Promise.allSettled(jobs.map((j) => j.job));
  results.forEach((r, i) => {
    if (r.status === 'rejected')
      deps.log?.('notification failed', {
        to: jobs[i]?.to,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
  });
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  );

/** An alert as an email: plain text plus a simple HTML version. */
export function alertEmail(
  to: string,
  title: string,
  text: string,
  link: string,
  publicUrl: string,
) {
  const settings = `${publicUrl}/settings/notifications`;
  return {
    to,
    subject: title,
    text: `${text}\n\nOpen the conversation: ${link}\n\n—\nSocial Switchboard. Choose what you get in Settings → Notifications: ${settings}`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
<p style="font-size:17px;font-weight:700;margin:0 0 8px">${escapeHtml(title)}</p>
<p style="margin:0 0 16px;white-space:pre-wrap">${escapeHtml(text)}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d4aff;color:#fff;padding:10px 16px;text-decoration:none;font-weight:700">Open the conversation</a></p>
<p style="margin:0;font-size:12px;color:#666">Social Switchboard · <a href="${escapeHtml(settings)}" style="color:#666">Choose what you get</a></p>
</div>`,
  };
}
