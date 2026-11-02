import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { decryptSecret } from './crypto';
import type { Db } from './db/client';
import {
  type AlertChannel,
  contactIdentities,
  contacts,
  type NoticeKind,
  notificationPrefs,
  pushSubscriptions,
  type SmsProvider,
  type SmtpSettings,
  type TelnyxSettings,
  type TwilioSettings,
  users,
  workspaceMembers,
  workspaces,
} from './db/schema';
import { isGone, sendWebPush } from './webpush';

// Alerts when a conversation needs someone. Switchboard's own notifications need no setup (each
// person turns them on per device); admins set up email (an SMTP server) and texts (Twilio or
// Telnyx); each
// teammate picks which events reach them and how. Best effort, and never in the way of handling
// the message.

export type Notice = {
  workspaceId: string;
  contactId: string;
  channel: string;
  kind: NoticeKind;
  text?: string;
  /** For "assigned" and "snooze": the teammate it's for. */
  userId?: string;
};

export const NOTICE_INFO: Record<NoticeKind, { label: string; help: string }> = {
  handoff: {
    label: 'Needs a person',
    help: 'An automation or the AI handed a conversation to the team.',
  },
  assigned: { label: 'Assigned to me', help: 'A teammate gave you a conversation.' },
  team: { label: 'Alerts from automations', help: 'An automation’s “notify the team” step.' },
  unanswered: { label: 'Unanswered messages', help: 'A DM no automation answered.' },
  paused: {
    label: 'Messages while the bot is paused',
    help: 'Someone wrote while the bot was paused for them.',
  },
  snooze: { label: 'Back from snooze', help: 'A conversation you snoozed is back in the inbox.' },
};

/** Alerts meant for one teammate, not the whole team. */
const PERSONAL: NoticeKind[] = ['assigned', 'snooze'];

/**
 * What a teammate gets until they choose: everything as a notification (on the devices they
 * turned on), what needs someone by email too. Never texts, which cost money.
 */
export const DEFAULT_EVENTS: Record<NoticeKind, AlertChannel[]> = {
  handoff: ['browser', 'email'],
  assigned: ['browser', 'email'],
  team: ['browser', 'email'],
  unanswered: ['browser'],
  paused: ['browser'],
  snooze: ['browser'],
};

/** One alert per contact and kind in this window, so a chatty conversation doesn't buzz nonstop. */
const QUIET_MS = 10 * 60_000;
const lastSent = new Map<string, number>();

/** Swappable for tests (Twilio). */
let http: typeof fetch = (...args) => fetch(...args);
export function setNotifyHttp(impl: typeof fetch) {
  http = impl;
}

// ------------------------------------------------------------------ email (SMTP)

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Where replies go, when not back to the sending address. */
  replyTo?: string;
};
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
    replyTo: mail.replyTo,
  });
};
/** Swappable for tests. */
export function setMailer(m: Mailer) {
  mailer = m;
}
export const sendEmail = (smtp: SmtpSettings & { password?: string }, mail: Mail) =>
  mailer(smtp, mail);

// ------------------------------------------------------------------ texts (Twilio or Telnyx)

/** The account texts go out from, secrets decrypted. */
export type SmsSender =
  | ({ provider: 'twilio'; token: string } & TwilioSettings)
  | ({ provider: 'telnyx'; apiKey: string } & TelnyxSettings);

type SmsColumns = {
  smsProvider: SmsProvider | null;
  twilio: TwilioSettings | null;
  twilioTokenEnc: string | null;
  telnyx: TelnyxSettings | null;
  telnyxKeyEnc: string | null;
};

/** Which providers are fully set up. */
export const smsReady = (ws: SmsColumns): Record<SmsProvider, boolean> => ({
  twilio: Boolean(ws.twilio && ws.twilioTokenEnc),
  telnyx: Boolean(ws.telnyx && ws.telnyxKeyEnc),
});

/** The provider picked to send texts: the chosen one, or whichever is set up (Twilio first). */
export function smsChoice(ws: SmsColumns): SmsProvider | null {
  const ready = smsReady(ws);
  return ws.smsProvider ?? (ready.twilio ? 'twilio' : ready.telnyx ? 'telnyx' : null);
}

/**
 * Sends one text through whichever provider is in use, and returns the provider's id for it.
 * Throws when the provider refuses it outright (the test shows why).
 */
export function sendSms(sender: SmsSender, to: string, body: string): Promise<string | undefined> {
  return sender.provider === 'telnyx' ? sendTelnyx(sender, to, body) : sendTwilio(sender, to, body);
}

/**
 * Where a sent text got to. Providers accept a text first and only find out later whether it can
 * be delivered (an unregistered number, a landline, a carrier's spam filter), so this asks.
 */
export type SmsDelivery =
  | { state: 'pending' | 'sent' | 'delivered' }
  | { state: 'failed'; reason: string };

/** Twilio's error codes say little on their own; the common ones in plain words. */
const TWILIO_REASONS: Record<number, string> = {
  30003: 'The phone is off or out of reach.',
  30004: 'The person blocked this number.',
  30005: 'That phone number doesn’t exist.',
  30006: 'That number is a landline or can’t get texts.',
  30007: 'The carrier filtered it as spam.',
  30032: 'The toll-free number isn’t verified yet.',
  30034: 'The number isn’t registered for US business texting (10DLC) yet.',
};

export async function smsDelivery(sender: SmsSender, id: string): Promise<SmsDelivery> {
  if (sender.provider === 'telnyx') {
    const res = await http(`https://api.telnyx.com/v2/messages/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${sender.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json().catch(() => null)) as {
      data?: { to?: { status?: string }[]; errors?: { title?: string; detail?: string }[] };
    } | null;
    const status = j?.data?.to?.[0]?.status;
    if (status === 'delivered') return { state: 'delivered' };
    if (status === 'sending_failed' || status === 'delivery_failed') {
      const e = j?.data?.errors?.[0];
      return { state: 'failed', reason: e?.detail || e?.title || status.replace('_', ' ') };
    }
    return { state: status === 'sent' || status === 'delivery_unconfirmed' ? 'sent' : 'pending' };
  }
  const res = await http(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sender.accountSid)}/Messages/${encodeURIComponent(id)}.json`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${sender.accountSid}:${sender.token}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(8000),
    },
  );
  const j = (await res.json().catch(() => null)) as {
    status?: string;
    error_code?: number | null;
    error_message?: string | null;
  } | null;
  if (j?.status === 'delivered') return { state: 'delivered' };
  if (j?.status === 'failed' || j?.status === 'undelivered') {
    const code = j.error_code ?? undefined;
    return {
      state: 'failed',
      reason:
        (code && TWILIO_REASONS[code]) ||
        j.error_message ||
        (code ? `Twilio error ${code}.` : 'Twilio couldn’t deliver it.'),
    };
  }
  return { state: j?.status === 'sent' ? 'sent' : 'pending' };
}

let poll = { every: 1500, max: 15_000 };
/** Swappable for tests. */
export function setSmsPolling(timing: { every: number; max: number }) {
  poll = timing;
}

/** Asks about a text every second or two until it's delivered or refused, or ~15 seconds pass. */
export async function awaitSmsDelivery(sender: SmsSender, id: string): Promise<SmsDelivery> {
  const until = Date.now() + poll.max;
  let last: SmsDelivery = { state: 'pending' };
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, poll.every));
    try {
      last = await smsDelivery(sender, id);
    } catch {
      // A hiccup asking; ask again.
    }
    if (last.state === 'delivered' || last.state === 'failed') break;
  }
  return last;
}

/** Twilio: `from` is a phone number, or a Messaging Service SID (MG…). */
async function sendTwilio(
  twilio: TwilioSettings & { token: string },
  to: string,
  body: string,
): Promise<string | undefined> {
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
  const j = (await res.json().catch(() => null)) as { message?: string; sid?: string } | null;
  if (!res.ok)
    throw new Error(`Twilio answered ${res.status}${j?.message ? `: ${j.message}` : '.'}`);
  return j?.sid;
}

/** Telnyx's Messaging API: a number on the account, and an API key. */
async function sendTelnyx(
  telnyx: TelnyxSettings & { apiKey: string },
  to: string,
  body: string,
): Promise<string | undefined> {
  const res = await http('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${telnyx.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: telnyx.from, to, text: body }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => null)) as {
    data?: { id?: string };
    errors?: { title?: string; detail?: string }[];
  } | null;
  if (!res.ok) {
    const why = j?.errors?.[0]?.detail || j?.errors?.[0]?.title;
    throw new Error(`Telnyx answered ${res.status}${why ? `: ${why}` : '.'}`);
  }
  return j?.data?.id;
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
      smtp: workspaces.smtp,
      smtpPassEnc: workspaces.smtpPassEnc,
      twilio: workspaces.twilio,
      twilioTokenEnc: workspaces.twilioTokenEnc,
      telnyx: workspaces.telnyx,
      telnyxKeyEnc: workspaces.telnyxKeyEnc,
      smsProvider: workspaces.smsProvider,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const dec = (enc: string | null | undefined) => (enc ? decryptSecret(appSecret, enc) : undefined);
  const provider = ws ? smsChoice(ws) : null;
  let sms: SmsSender | undefined;
  if (provider === 'twilio' && ws?.twilio && ws.twilioTokenEnc)
    sms = { provider, ...ws.twilio, token: dec(ws.twilioTokenEnc) ?? '' };
  if (provider === 'telnyx' && ws?.telnyx && ws.telnyxKeyEnc)
    sms = { provider, ...ws.telnyx, apiKey: dec(ws.telnyxKeyEnc) ?? '' };
  return {
    smtp: ws?.smtp ? { ...ws.smtp, password: dec(ws.smtpPassEnc) } : undefined,
    /** The text-message sender in use, if it's set up. */
    sms,
  };
}

/** Each teammate's devices, addresses and choices (defaults filled in). */
export async function recipients(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      userId: workspaceMembers.userId,
      accountEmail: users.email,
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
  const devices = rows.length
    ? await db
        .select()
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.workspaceId, workspaceId),
            inArray(
              pushSubscriptions.userId,
              rows.map((r) => r.userId),
            ),
          ),
        )
    : [];
  return rows.map((r) => ({
    userId: r.userId,
    devices: devices.filter((d) => d.userId === r.userId),
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
    snooze: `${name} is back from snooze`,
  }[n.kind];
  const text = (n.text || 'Open the inbox to see it.').slice(0, 300);
  const link = `${deps.publicUrl}/inbox/${n.contactId}`;

  const from = await senders(deps.db, deps.appSecret, n.workspaceId);
  const jobs: { to: string; job: Promise<void> }[] = [];
  const personal = PERSONAL.includes(n.kind);

  for (const r of await recipients(deps.db, n.workspaceId)) {
    if (personal && r.userId !== n.userId) continue;
    const ways = r.events[n.kind] ?? [];
    if (ways.includes('browser'))
      for (const device of r.devices)
        jobs.push({
          to: 'notification',
          job: notifyDevice(deps, device, { title, body: text, url: link, tag: n.contactId }).then(
            () => {},
          ),
        });
    if (ways.includes('email') && from.smtp && r.email)
      jobs.push({
        to: 'email',
        job: sendEmail(from.smtp, alertEmail(r.email, title, text, link, deps.publicUrl)),
      });
    if (ways.includes('sms') && from.sms && r.phone)
      jobs.push({
        to: 'text',
        job: sendSms(from.sms, r.phone, `${`${title}: ${text}`.slice(0, 280)}\n${link}`).then(
          () => {},
        ),
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

/**
 * One device's notification. A device the push service says is gone is forgotten (and false
 * comes back).
 */
export async function notifyDevice(
  deps: Pick<Deps, 'db' | 'appSecret' | 'publicUrl'>,
  device: typeof pushSubscriptions.$inferSelect,
  message: { title: string; body: string; url: string; tag?: string },
) {
  try {
    await sendWebPush(deps.appSecret, deps.publicUrl, device, message);
  } catch (err) {
    if (isGone(err)) {
      await deps.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
      return false;
    }
    throw err;
  }
  await deps.db
    .update(pushSubscriptions)
    .set({ lastSentAt: new Date() })
    .where(eq(pushSubscriptions.id, device.id));
  return true;
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

/** An invite to join the team, with the one-time link; replies go to whoever sent it. */
export function inviteEmail(invite: {
  to: string;
  from: { name: string; email: string };
  workspace: string;
  role: 'admin' | 'agent';
  link: string;
  expiresAt: Date;
}) {
  const what =
    invite.role === 'admin'
      ? 'You’ll be able to run everything: the inbox, automations, channels and notifications.'
      : 'You’ll answer messages in the shared inbox and help with contacts and automations.';
  const until = invite.expiresAt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const subject = `${invite.from.name} invited you to ${invite.workspace} on Social Switchboard`;
  return {
    to: invite.to,
    replyTo: invite.from.email,
    subject,
    text: `${subject}.\n\n${what}\n\nJoin the team: ${invite.link}\n\nThe link works once, until ${until}. If you weren’t expecting this, you can ignore it.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
<p style="font-size:17px;font-weight:700;margin:0 0 8px">${escapeHtml(subject)}</p>
<p style="margin:0 0 16px">${escapeHtml(what)}</p>
<p style="margin:0 0 16px"><a href="${escapeHtml(invite.link)}" style="display:inline-block;background:#6d4aff;color:#fff;padding:10px 16px;text-decoration:none;font-weight:700">Join the team</a></p>
<p style="margin:0 0 24px;font-size:13px;color:#666">The link works once, until ${escapeHtml(until)}. If you weren’t expecting this, you can ignore it.</p>
<p style="margin:0;font-size:12px;color:#666">Social Switchboard</p>
</div>`,
  };
}
