import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError, api, type Me, useApi } from '../api';
import { currentSubscription, needsInstall, pushSupported, turnOffHere, turnOnHere } from '../push';
import { Field, FormError, SecretField, Select, timeAgo } from '../ui';

// Settings → Notifications: everyone picks which alerts reach them and how (Switchboard's own
// notifications on their devices, email, text); owners and admins set up email (an SMTP server)
// and texts (a Twilio account).

type Channel = 'browser' | 'email' | 'sms';
type Device = {
  id: string;
  label: string;
  endpoint: string;
  createdAt: string;
  lastSentAt: string | null;
};
type Settings = {
  email: {
    host: string;
    port: number;
    security: 'tls' | 'starttls' | 'none';
    user: string;
    from: string;
    fromName: string;
    hasPassword: boolean;
  } | null;
  sms: { accountSid: string; from: string; hasToken: boolean } | null;
  mine: {
    email: string | null;
    accountEmail: string;
    phone: string | null;
    events: Record<string, Channel[]>;
    devices: Device[];
  };
  vapidKey: string;
  kinds: { id: string; label: string; help: string }[];
};

const CHANNELS: { id: Channel; label: string }[] = [
  { id: 'browser', label: 'App' },
  { id: 'email', label: 'Email' },
  { id: 'sms', label: 'Text' },
];

type Security = 'tls' | 'starttls' | 'none';
type ServiceId =
  | 'resend'
  | 'sendgrid'
  | 'postmark'
  | 'ses'
  | 'mailgun'
  | 'gmail'
  | 'microsoft'
  | 'other';

/**
 * Email services we know. Each asks only for what it needs (often one API key); its server
 * settings fill themselves in and stay folded away.
 */
const SERVICES: {
  id: ServiceId;
  name: string;
  host: string;
  port: number;
  security: Security;
  /** A fixed username, for services where the key does the work. */
  user?: string;
  /** Otherwise, what the person types as the username. */
  userLabel?: string;
  userPlaceholder?: string;
  secretLabel: string;
  /** Mailbox services send as the account itself, so there's no separate From address. */
  sendsAsUser?: boolean;
  /** Where the credentials come from, and what's easy to get wrong. */
  steps: string;
  link?: { href: string; label: string };
}[] = [
  {
    id: 'resend',
    name: 'Resend',
    host: 'smtp.resend.com',
    port: 465,
    security: 'tls',
    user: 'resend',
    secretLabel: 'API key',
    steps:
      'In Resend, open API Keys → Create API Key with “Sending access”. The From address has to be on a domain that shows Verified under Domains.',
    link: { href: 'https://resend.com/api-keys', label: 'Open Resend API keys' },
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    host: 'smtp.sendgrid.net',
    port: 587,
    security: 'starttls',
    user: 'apikey',
    secretLabel: 'API key',
    steps:
      'In SendGrid, Settings → API Keys → Create API Key (“Mail Send” is enough). The From address has to be a verified sender or on an authenticated domain.',
    link: { href: 'https://app.sendgrid.com/settings/api_keys', label: 'Open SendGrid API keys' },
  },
  {
    id: 'postmark',
    name: 'Postmark',
    host: 'smtp.postmarkapp.com',
    port: 587,
    security: 'starttls',
    userLabel: 'Access key',
    secretLabel: 'Secret key',
    steps:
      'In Postmark, open your server → Settings → SMTP → Generate an SMTP token, and copy its access key and secret key. The From address has to be a confirmed sender signature or domain.',
  },
  {
    id: 'ses',
    name: 'Amazon SES',
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: 587,
    security: 'starttls',
    userLabel: 'SMTP username',
    secretLabel: 'SMTP password',
    steps:
      'In the SES console, SMTP settings → Create SMTP credentials (these aren’t your AWS access keys). The region is the one your SES account sends from.',
  },
  {
    id: 'mailgun',
    name: 'Mailgun',
    host: 'smtp.mailgun.org',
    port: 587,
    security: 'starttls',
    userLabel: 'SMTP login',
    userPlaceholder: 'postmaster@mg.yourdomain.com',
    secretLabel: 'SMTP password',
    steps:
      'In Mailgun, Sending → Domain settings → SMTP credentials. Accounts in the EU region use smtp.eu.mailgun.org (under Server settings).',
  },
  {
    id: 'gmail',
    name: 'Gmail or Google Workspace',
    host: 'smtp.gmail.com',
    port: 587,
    security: 'starttls',
    userLabel: 'Gmail address',
    userPlaceholder: 'you@gmail.com',
    secretLabel: 'App password',
    sendsAsUser: true,
    steps:
      'Use an app password, not your normal one: Google Account → Security → 2-Step Verification → App passwords. Alerts come from this address.',
    link: { href: 'https://myaccount.google.com/apppasswords', label: 'Open Google app passwords' },
  },
  {
    id: 'microsoft',
    name: 'Microsoft 365 or Outlook',
    host: 'smtp.office365.com',
    port: 587,
    security: 'starttls',
    userLabel: 'Mailbox address',
    secretLabel: 'Password',
    sendsAsUser: true,
    steps:
      'Your admin has to turn on “Authenticated SMTP” for the mailbox, and Microsoft is phasing out password sign-in for it, so a sending service like Resend lasts longer.',
  },
  {
    id: 'other',
    name: 'Another SMTP server',
    host: '',
    port: 587,
    security: 'starttls',
    userLabel: 'Username',
    secretLabel: 'Password',
    steps:
      'Any email service or server with SMTP. Its help pages list the server, port and security.',
  },
];

const SES_HOST = /^email-smtp\.([a-z0-9-]+)\.amazonaws\.com$/;

/** "API key" stays as it is; "App password" reads "app password" mid-sentence. */
const inSentence = (label: string) =>
  /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);

/** Which service a saved server belongs to. */
function serviceOf(host: string): ServiceId {
  if (SES_HOST.test(host)) return 'ses';
  if (/(^|\.)mailgun\.org$/.test(host)) return 'mailgun';
  return SERVICES.find((x) => x.host && x.host === host)?.id ?? 'other';
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? (Object.values(err.fieldErrors())[0] ?? (err.code.includes(' ') ? err.code : fallback))
    : fallback;

type Message = { ok: boolean; text: string } | undefined;
function Result({ message }: { message: Message }) {
  if (!message) return null;
  return message.ok ? (
    <p className="text-[14px] font-bold text-success">{message.text}</p>
  ) : (
    <FormError message={message.text} />
  );
}

const reveal = (which: 'email' | 'sms') => async () =>
  (await api<{ value: string }>('/settings/notifications/reveal', { which })).value;

export function NotificationsSection({ me }: { me: Me }) {
  const settings = useApi<Settings>('/settings/notifications');
  const role = me.workspaces[0]?.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const s = settings.data;

  return (
    <section aria-labelledby="notifications-h" className="grid gap-4">
      <div>
        <h2 id="notifications-h" className="font-display text-display-sm font-bold">
          Notifications
        </h2>
        <p className="mt-1 text-[15px] text-muted">
          Alerts when a conversation needs someone. Everyone picks what reaches them and how; owners
          and admins set up email and texts. Tapping one opens the conversation.
        </p>
      </div>
      {s && (
        <>
          <ThisDevice settings={s} reload={settings.reload} />
          <MyAlerts settings={s} reload={settings.reload} />
          <div className="grid gap-3">
            <h3 className="font-bold">Email and texts</h3>
            <EmailSender settings={s} isAdmin={isAdmin} reload={settings.reload} />
            <SmsSender settings={s} isAdmin={isAdmin} reload={settings.reload} />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Switchboard's own notifications on this browser or installed app, and the other devices that
 * have them on. Nothing to set up first: they come from this server.
 */
function ThisDevice({ settings: s, reload }: { settings: Settings; reload: () => Promise<void> }) {
  const [endpoint, setEndpoint] = useState<string | null>();
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void currentSubscription().then(
      (sub) => setEndpoint(sub?.endpoint ?? null),
      () => setEndpoint(null),
    );
  }, []);
  const here = s.mine.devices.find((d) => d.endpoint === endpoint);
  const supported = pushSupported();

  async function turnOn() {
    setBusy(true);
    setMessage(undefined);
    try {
      const why = await turnOnHere(s.vapidKey);
      if (why) setMessage({ ok: false, text: why });
      else {
        setEndpoint((await currentSubscription())?.endpoint ?? null);
        await reload();
        setMessage({
          ok: true,
          text: 'On. You’ll get a notification when a conversation needs you.',
        });
      }
    } catch (err) {
      setMessage({ ok: false, text: errorText(err, 'Couldn’t turn notifications on here.') });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setMessage(undefined);
    try {
      await api('/settings/notifications/test', { to: 'browser' });
      setMessage({ ok: true, text: 'Sent. It should pop up in a moment.' });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err, 'The test didn’t go through.') });
    }
  }

  return (
    <div className="card card-flat grid gap-3">
      <div>
        <h3 className="font-bold">Notifications on this device</h3>
        <p className="mt-1 text-[14px] text-muted">
          Switchboard’s own notifications, on your phone’s lock screen or your computer. Turn them
          on on each device you use; nothing else to set up.
        </p>
      </div>
      {!supported ? (
        <p className="text-[14px]">
          {needsInstall()
            ? 'On iPhone, add Switchboard to your Home Screen first (Share → Add to Home Screen), open it from there, and turn notifications on here.'
            : 'This browser can’t show notifications. Try Chrome, Edge, Firefox or Safari.'}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {here ? (
            <>
              <span className="chip chip-success">On here</span>
              <button type="button" className="btn btn-sm" onClick={() => void test()}>
                Send a test
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setMessage(undefined);
                  try {
                    await turnOffHere(here.id);
                    setEndpoint(null);
                    await reload();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Turn off here
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || endpoint === undefined}
              onClick={() => void turnOn()}
            >
              Turn on notifications here
            </button>
          )}
        </div>
      )}
      <Result message={message} />
      {s.mine.devices.some((d) => d.endpoint !== endpoint) && (
        <div className="grid gap-1.5">
          <h4 className="text-[13px] font-bold text-muted">
            {here ? 'Your other devices' : 'Your devices'}
          </h4>
          <ul className="divide-y-2 divide-line border-2 border-line">
            {s.mine.devices
              .filter((d) => d.endpoint !== endpoint)
              .map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-[14px]">
                  <span className="min-w-0 flex-1">
                    <span className="font-bold">{d.label}</span>
                    <span className="block text-[13px] text-muted">
                      Added {timeAgo(d.createdAt)}
                      {d.lastSentAt ? ` · last notified ${timeAgo(d.lastSentAt)}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="linkbtn min-h-10 text-danger"
                    onClick={async () => {
                      await api(`/settings/notifications/devices/${d.id}`, undefined, 'DELETE');
                      await reload();
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** This teammate's own addresses and which alerts go where. */
function MyAlerts({ settings: s, reload }: { settings: Settings; reload: () => Promise<void> }) {
  const [events, setEvents] = useState(s.mine.events);
  const [phone, setPhone] = useState(s.mine.phone ?? '');
  const [message, setMessage] = useState<Message>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // A channel can be picked once it can actually reach this person.
  const ready: Record<Channel, string | undefined> = {
    browser: s.mine.devices.length ? undefined : 'Turn notifications on for a device above.',
    email: s.email ? undefined : 'An owner or admin needs to set up email.',
    sms: !s.sms
      ? 'An owner or admin needs to set up text messages.'
      : phone.trim()
        ? undefined
        : 'Add your phone number below.',
  };

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    setBusy(true);
    setMessage(undefined);
    setErrors({});
    try {
      await api(
        '/settings/notifications/mine',
        {
          email: email || null,
          phone: phone.trim() || null,
          events,
        },
        'PUT',
      );
      await reload();
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setMessage({ ok: false, text: errorText(err, 'Couldn’t save.') });
    } finally {
      setBusy(false);
    }
  }

  async function test(to: Channel) {
    setMessage(undefined);
    try {
      await api('/settings/notifications/test', { to });
      setMessage({
        ok: true,
        text: {
          browser: 'Sent. It should pop up in a moment.',
          email: 'Sent. Check your inbox (and spam, the first time).',
          sms: 'Sent. It should arrive in a few seconds.',
        }[to],
      });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err, 'The test didn’t go through.') });
    }
  }

  return (
    <form onSubmit={save} className="card card-flat grid gap-4" autoComplete="off">
      <h3 className="font-bold">My alerts</h3>
      {/* Each alert with a toggle per way of getting it: fits a phone without sideways scrolling. */}
      <ul className="divide-y-2 divide-line border-2 border-edge">
        {s.kinds.map((k) => (
          <li
            key={k.id}
            className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <span>
              <span className="font-bold">{k.label}</span>
              <span className="block text-[13px] text-muted">{k.help}</span>
            </span>
            <span className="grid grid-cols-3 gap-1.5 sm:flex">
              {CHANNELS.map((c) => {
                const on = (events[k.id] ?? []).includes(c.id) && !ready[c.id];
                return (
                  <label
                    key={c.id}
                    title={ready[c.id]}
                    className={`flex min-h-10 cursor-pointer items-center justify-center gap-1 border-2 px-1 text-[13px] font-bold sm:px-2.5 has-disabled:cursor-not-allowed has-disabled:opacity-45 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary ${on ? 'border-edge bg-surface-2 text-ink' : 'border-line text-muted'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      disabled={Boolean(ready[c.id])}
                      aria-label={`${k.label} by ${c.label}`}
                      onChange={() =>
                        setEvents((ev) => ({
                          ...ev,
                          [k.id]: (ev[k.id] ?? []).includes(c.id)
                            ? (ev[k.id] ?? []).filter((x) => x !== c.id)
                            : [...(ev[k.id] ?? []), c.id],
                        }))
                      }
                    />
                    {on && <span aria-hidden>✓</span>}
                    {c.label}
                  </label>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
      {CHANNELS.some((c) => ready[c.id]) && (
        <ul className="grid gap-0.5 text-[13px] text-muted">
          {CHANNELS.filter((c) => ready[c.id]).map((c) => (
            <li key={c.id}>
              {c.label}: {ready[c.id]}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Email"
          name="email"
          type="email"
          defaultValue={s.mine.email ?? ''}
          placeholder={s.mine.accountEmail}
          error={errors.email}
          hint={`Leave empty to use ${s.mine.accountEmail}.`}
        />
        <Field
          label="Phone for texts"
          name="phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+18015551234"
          error={errors.phone}
          hint="With the country code."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
        {s.email && (
          <button type="button" className="btn" onClick={() => void test('email')}>
            Test email
          </button>
        )}
        {s.sms && s.mine.phone && (
          <button type="button" className="btn" onClick={() => void test('sms')}>
            Test text
          </button>
        )}
      </div>
      <Result message={message} />
    </form>
  );
}

/** One way of sending, folded away until needed. */
function SenderCard({
  title,
  status,
  ok,
  children,
}: {
  title: string;
  status: string;
  ok: boolean;
  children: ReactNode;
}) {
  return (
    <details className="card card-flat group p-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3">
        <span className="flex-1 font-bold">{title}</span>
        <span className={`chip ${ok ? 'chip-success' : ''}`}>{status}</span>
        <span className="text-muted transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
      </summary>
      <div className="grid gap-3 border-t-2 border-line px-5 py-4">{children}</div>
    </details>
  );
}

function EmailSender({
  settings: s,
  isAdmin,
  reload,
}: {
  settings: Settings;
  isAdmin: boolean;
  reload: () => Promise<void>;
}) {
  const saved = s.email;
  const savedService = saved ? serviceOf(saved.host) : undefined;
  const [service, setService] = useState<ServiceId | ''>(savedService ?? '');
  const [host, setHost] = useState(saved?.host ?? '');
  const [port, setPort] = useState(String(saved?.port ?? 587));
  const [security, setSecurity] = useState<Security>(saved?.security ?? 'starttls');
  const [user, setUser] = useState(saved?.user ?? '');
  const [message, setMessage] = useState<Message>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const svc = SERVICES.find((x) => x.id === service);
  // The saved secret belongs to the saved service; another service needs its own.
  const hasSecret = Boolean(saved?.hasPassword) && service === savedService;

  function pick(id: ServiceId | '') {
    setService(id);
    setErrors({});
    setMessage(undefined);
    const next = SERVICES.find((x) => x.id === id);
    if (!next) return;
    // Back to the saved service: its saved settings. Otherwise that service's own.
    const was = id === savedService ? saved : null;
    setHost(was ? was.host : next.host);
    setPort(String(was ? was.port : next.port));
    setSecurity(was ? was.security : next.security);
    setUser(next.user ?? was?.user ?? '');
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!svc) return;
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '').trim();
    setMessage(undefined);
    setErrors({});
    if (!password && !hasSecret) {
      setErrors({ password: `Paste the ${inSentence(svc.secretLabel)}.` });
      return;
    }
    setBusy(true);
    try {
      await api(
        '/settings/notifications/email',
        {
          host: host.trim(),
          port: Number(port),
          security,
          user: user.trim(),
          ...(password && { password }),
          from: svc.sendsAsUser ? user.trim() : String(form.get('from') ?? '').trim(),
          fromName: String(form.get('fromName') ?? '').trim() || 'Social Switchboard',
        },
        'PUT',
      );
      await reload();
      setMessage({ ok: true, text: 'Saved. Send yourself a test to check it.' });
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = err.fieldErrors();
        // A mailbox service sends as the username, so a bad From address is the username.
        if (svc.sendsAsUser && fields.from) fields.user = fields.from;
        setErrors(fields);
      }
      setMessage({ ok: false, text: errorText(err, 'Couldn’t save.') });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setMessage(undefined);
    setBusy(true);
    try {
      await api('/settings/notifications/test', { to: 'email' });
      setMessage({
        ok: true,
        text: `Sent to ${s.mine.email || s.mine.accountEmail}. Check spam the first time.`,
      });
    } catch (err) {
      const text = errorText(err, 'The test didn’t go through.');
      // SMTP's "535" is a refused sign-in: almost always the key or password.
      setMessage({
        ok: false,
        text:
          svc && /\b535\b|invalid login|authentication/i.test(text)
            ? `${svc.name} didn’t accept the ${inSentence(svc.secretLabel)}. Check it, or make a new one and paste it with Replace. (${text})`
            : text,
      });
    } finally {
      setBusy(false);
    }
  }

  const serverFields = (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
        <Field
          label="Server"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="smtp.example.com"
          error={errors.host}
        />
        <Field
          label="Port"
          inputMode="numeric"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          error={errors.port}
        />
      </div>
      <Select
        label="Security"
        value={security}
        onChange={(e) => setSecurity(e.target.value as Security)}
      >
        <option value="starttls">STARTTLS (usually port 587)</option>
        <option value="tls">TLS from the start (usually port 465)</option>
        <option value="none">None (only for a server on your own network)</option>
      </Select>
    </>
  );

  return (
    <SenderCard
      title="Email"
      status={
        saved ? (SERVICES.find((x) => x.id === savedService)?.name ?? 'Set up') : 'Not set up'
      }
      ok={Boolean(saved)}
    >
      {isAdmin ? (
        <form onSubmit={save} className="grid gap-4" autoComplete="off">
          <Select
            label="Which service do you send email with?"
            value={service}
            onChange={(e) => pick(e.target.value as ServiceId | '')}
          >
            <option value="">Choose one…</option>
            {SERVICES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
          {!svc && (
            <p className="text-[14px] text-muted">
              Alerts go out through an email service you already use. A sending service like Resend
              or SendGrid needs just an API key; use an address on your own domain so alerts don’t
              land in spam.
            </p>
          )}

          {svc && (
            <>
              <div className="grid gap-1.5 border-l-4 border-primary bg-surface-2 px-3 py-2.5 text-[14px]">
                <p>{svc.steps}</p>
                {svc.link && (
                  <a
                    href={svc.link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-fit"
                  >
                    {svc.link.label} ↗
                  </a>
                )}
              </div>

              {svc.id === 'ses' && (
                <Field
                  label="Region"
                  value={SES_HOST.exec(host)?.[1] ?? ''}
                  onChange={(e) =>
                    setHost(`email-smtp.${e.target.value.trim().toLowerCase()}.amazonaws.com`)
                  }
                  placeholder="us-east-1"
                  hint="Like us-east-1 or eu-west-1."
                  error={errors.host}
                />
              )}
              {svc.id === 'other' && serverFields}
              {!svc.user && (
                <Field
                  label={svc.userLabel ?? 'Username'}
                  type={svc.sendsAsUser ? 'email' : 'text'}
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder={svc.userPlaceholder}
                  error={errors.user}
                />
              )}
              <SecretField
                key={service}
                label={svc.secretLabel}
                name="password"
                saved={hasSecret}
                hint={hasSecret ? 'Saved and encrypted.' : undefined}
                error={errors.password}
                reveal={reveal('email')}
              />
              <div className="grid items-start gap-3 sm:grid-cols-2">
                {!svc.sendsAsUser && (
                  <Field
                    label="Send alerts from"
                    name="from"
                    type="email"
                    defaultValue={saved?.from ?? ''}
                    placeholder="noreply@yourdomain.com"
                    error={errors.from}
                  />
                )}
                <Field
                  label="Sender name"
                  name="fromName"
                  defaultValue={saved?.fromName ?? 'Social Switchboard'}
                  hint="What inboxes show as who it’s from."
                  error={errors.fromName}
                />
              </div>
              {svc.id !== 'other' && (
                <details className="group/server">
                  <summary className="w-fit cursor-pointer list-none text-[14px] font-bold text-muted">
                    <span
                      className="inline-block transition-transform group-open/server:rotate-90"
                      aria-hidden
                    >
                      ›
                    </span>{' '}
                    Server settings
                  </summary>
                  <div className="mt-3 grid gap-3">
                    {serverFields}
                    {svc.user && (
                      <Field
                        label="Username"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        error={errors.user}
                      />
                    )}
                  </div>
                </details>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Save
                </button>
                {saved && service === savedService && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void test()}>
                    Send me a test
                  </button>
                )}
                {saved && (
                  <button
                    type="button"
                    className="linkbtn ml-auto text-danger"
                    onClick={async () => {
                      if (!confirm('Turn off email alerts for everyone?')) return;
                      await api('/settings/notifications/email', undefined, 'DELETE');
                      pick('');
                      await reload();
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              <Result message={message} />
            </>
          )}
        </form>
      ) : (
        <p className="text-[14px]">
          {saved ? `Alerts come from ${saved.from}.` : 'An owner or admin can set this up.'}
        </p>
      )}
    </SenderCard>
  );
}

function SmsSender({
  settings: s,
  isAdmin,
  reload,
}: {
  settings: Settings;
  isAdmin: boolean;
  reload: () => Promise<void>;
}) {
  const saved = s.sms;
  const [message, setMessage] = useState<Message>();
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const token = String(form.get('token') ?? '').trim();
    setMessage(undefined);
    setErrors({});
    try {
      await api(
        '/settings/notifications/sms',
        {
          accountSid: String(form.get('accountSid') ?? '').trim(),
          ...(token && { token }),
          from: String(form.get('from') ?? '').trim(),
        },
        'PUT',
      );
      await reload();
      setMessage({ ok: true, text: 'Saved. Add your phone in My alerts to test it.' });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setMessage({ ok: false, text: errorText(err, 'Couldn’t save.') });
    }
  }

  return (
    <SenderCard
      title="Text messages (Twilio)"
      status={saved ? 'Set up' : 'Not set up'}
      ok={Boolean(saved)}
    >
      <p className="text-[14px] text-muted">
        Texts go out from your own{' '}
        <a href="https://www.twilio.com" target="_blank" rel="noopener noreferrer">
          Twilio
        </a>{' '}
        account, which charges per text. Sending to US numbers needs a number registered for
        business texting first; Twilio’s console walks you through it.
      </p>
      {isAdmin ? (
        <form onSubmit={save} className="grid gap-3" autoComplete="off">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Account SID"
              name="accountSid"
              defaultValue={saved?.accountSid ?? ''}
              placeholder="AC…"
              error={errors.accountSid}
              hint="Twilio console → Account Info."
            />
            <SecretField
              label="Auth token"
              name="token"
              saved={Boolean(saved?.hasToken)}
              hint={saved?.hasToken ? 'Saved and encrypted.' : 'Next to the Account SID.'}
              error={errors.token}
              reveal={reveal('sms')}
            />
            <Field
              label="Send from"
              name="from"
              defaultValue={saved?.from ?? ''}
              placeholder="+18015550000"
              error={errors.from}
              hint="Your Twilio number with the country code, or a Messaging Service SID (MG…)."
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn btn-primary">
              Save
            </button>
            {saved && (
              <button
                type="button"
                className="linkbtn text-danger"
                onClick={async () => {
                  if (!confirm('Turn off text alerts for everyone?')) return;
                  await api('/settings/notifications/sms', undefined, 'DELETE');
                  await reload();
                }}
              >
                Remove
              </button>
            )}
          </div>
          <Result message={message} />
        </form>
      ) : (
        <p className="text-[14px]">
          {saved ? `Texts come from ${saved.from}.` : 'An owner or admin can set this up.'}
        </p>
      )}
    </SenderCard>
  );
}
