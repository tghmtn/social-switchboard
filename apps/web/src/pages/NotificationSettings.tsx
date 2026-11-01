import { type FormEvent, type ReactNode, useState } from 'react';
import { ApiError, api, type Me, useApi } from '../api';
import { Field, FormError, SecretField, Select } from '../ui';

// Settings → Notifications: everyone picks which alerts reach them and how (push, email, text);
// owners and admins set up how alerts are sent (ntfy, an SMTP server, a Twilio account).

type Channel = 'push' | 'email' | 'sms';
type Settings = {
  url: string | null;
  hasToken: boolean;
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
    pushUrl: string | null;
    hasPushToken: boolean;
    email: string | null;
    accountEmail: string;
    phone: string | null;
    events: Record<string, Channel[]>;
  };
  kinds: { id: string; label: string; help: string }[];
};

const CHANNELS: { id: Channel; label: string }[] = [
  { id: 'push', label: 'Push' },
  { id: 'email', label: 'Email' },
  { id: 'sms', label: 'Text' },
];

/** Common SMTP services; picking one fills in the server settings. */
const PRESETS: {
  name: string;
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  user?: string;
  note: string;
}[] = [
  {
    name: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com',
    port: 587,
    security: 'starttls',
    note: 'Use an app password (Google Account → Security → App passwords), not your normal one.',
  },
  {
    name: 'Microsoft 365 / Outlook',
    host: 'smtp.office365.com',
    port: 587,
    security: 'starttls',
    note: 'Your admin may need to allow SMTP sign-in for the mailbox.',
  },
  {
    name: 'Amazon SES',
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: 587,
    security: 'starttls',
    note: 'Change the region in the server name to yours, and use SES SMTP credentials.',
  },
  {
    name: 'Postmark',
    host: 'smtp.postmarkapp.com',
    port: 587,
    security: 'starttls',
    note: 'The username and password are both your server API token.',
  },
  {
    name: 'Resend',
    host: 'smtp.resend.com',
    port: 465,
    security: 'tls',
    user: 'resend',
    note: 'The password is your Resend API key.',
  },
  {
    name: 'SendGrid',
    host: 'smtp.sendgrid.net',
    port: 587,
    security: 'starttls',
    user: 'apikey',
    note: 'The password is your SendGrid API key.',
  },
  {
    name: 'Mailgun',
    host: 'smtp.mailgun.org',
    port: 587,
    security: 'starttls',
    note: 'Use the SMTP credentials from your Mailgun domain.',
  },
];

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

const reveal = (which: 'team' | 'email' | 'sms' | 'push') => async () =>
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
          and admins set up how alerts are sent. Tapping one opens the conversation.
        </p>
      </div>
      {s && (
        <>
          <MyAlerts settings={s} reload={settings.reload} />
          <div className="grid gap-3">
            <h3 className="font-bold">How alerts are sent</h3>
            <PushSender settings={s} isAdmin={isAdmin} reload={settings.reload} />
            <EmailSender settings={s} isAdmin={isAdmin} reload={settings.reload} />
            <SmsSender settings={s} isAdmin={isAdmin} reload={settings.reload} />
          </div>
        </>
      )}
    </section>
  );
}

/** This teammate's own addresses and which alerts go where. */
function MyAlerts({ settings: s, reload }: { settings: Settings; reload: () => Promise<void> }) {
  const [events, setEvents] = useState(s.mine.events);
  const [pushUrl, setPushUrl] = useState(s.mine.pushUrl ?? '');
  const [phone, setPhone] = useState(s.mine.phone ?? '');
  const [message, setMessage] = useState<Message>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // A channel can be picked once it can actually reach this person.
  const ready: Record<Channel, string | undefined> = {
    push: pushUrl.trim() ? undefined : 'Add your push topic below.',
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
    const pushToken = String(form.get('pushToken') ?? '').trim();
    setBusy(true);
    setMessage(undefined);
    setErrors({});
    try {
      await api(
        '/settings/notifications/mine',
        {
          pushUrl: pushUrl.trim() || null,
          ...(pushToken && { pushToken }),
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
          push: 'Sent. It should be on your phone now.',
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
      <div className="overflow-x-auto border-2 border-edge">
        <table className="w-full min-w-[460px] text-left text-[14px]">
          <thead className="bg-surface-2 text-label uppercase text-muted">
            <tr>
              <th className="px-3 py-2">When</th>
              {CHANNELS.map((c) => (
                <th key={c.id} className="w-20 px-3 py-2 text-center">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y-2 divide-line">
            {s.kinds.map((k) => (
              <tr key={k.id}>
                <td className="px-3 py-2">
                  <span className="font-bold">{k.label}</span>
                  <span className="block text-[13px] text-muted">{k.help}</span>
                </td>
                {CHANNELS.map((c) => {
                  const on = (events[k.id] ?? []).includes(c.id);
                  return (
                    <td key={c.id} className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={on && !ready[c.id]}
                        disabled={Boolean(ready[c.id])}
                        title={ready[c.id]}
                        aria-label={`${k.label} by ${c.label.toLowerCase()}`}
                        onChange={() =>
                          setEvents((ev) => ({
                            ...ev,
                            [k.id]: on
                              ? (ev[k.id] ?? []).filter((x) => x !== c.id)
                              : [...(ev[k.id] ?? []), c.id],
                          }))
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(['push', 'email', 'sms'] as const).some((c) => ready[c]) && (
        <ul className="grid gap-0.5 text-[13px] text-muted">
          {CHANNELS.filter((c) => ready[c.id]).map((c) => (
            <li key={c.id}>
              {c.label}: {ready[c.id]}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Field
            label="Push topic (ntfy)"
            name="pushUrl"
            type="url"
            value={pushUrl}
            onChange={(e) => setPushUrl(e.target.value)}
            placeholder="https://ntfy.sh/your-long-random-topic"
            error={errors.pushUrl}
            hint="Install the free ntfy app and subscribe to this topic."
          />
          {!pushUrl && (
            <button
              type="button"
              className="linkbtn w-fit text-[13px]"
              onClick={() => {
                const bytes = crypto.getRandomValues(new Uint8Array(12));
                const id = Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
                  .join('')
                  .slice(0, 18);
                setPushUrl(`https://ntfy.sh/switchboard-${id}`);
              }}
            >
              Make one for me
            </button>
          )}
        </div>
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
        <SecretField
          label="Push topic token (only if your topic needs one)"
          name="pushToken"
          saved={s.mine.hasPushToken}
          hint={s.mine.hasPushToken ? 'Saved and encrypted.' : undefined}
          placeholder="tk_…"
          reveal={reveal('push')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
        {s.mine.pushUrl && (
          <button type="button" className="btn" onClick={() => void test('push')}>
            Test push
          </button>
        )}
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

function PushSender({
  settings: s,
  isAdmin,
  reload,
}: {
  settings: Settings;
  isAdmin: boolean;
  reload: () => Promise<void>;
}) {
  const [message, setMessage] = useState<Message>();

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const url = String(form.get('url') ?? '').trim();
    const token = String(form.get('token') ?? '').trim();
    setMessage(undefined);
    try {
      await api('/settings/notifications', { url: url || null, ...(token && { token }) }, 'PUT');
      await reload();
      setMessage({ ok: true, text: url ? 'Saved. Send a test to check it.' : 'Team topic off.' });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err, 'Couldn’t save.') });
    }
  }

  return (
    <SenderCard title="Push (ntfy)" status={s.url ? 'Team topic on' : 'Ready'} ok>
      <p className="text-[14px] text-muted">
        Pushes go through{' '}
        <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer">
          ntfy
        </a>{' '}
        (free app; ntfy.sh or your own server), to each person’s own topic. Nothing to set up here
        unless you want a shared team topic: it hears every alert except personal assignments, handy
        for a shared phone or a team channel.
      </p>
      <form onSubmit={save} className="grid gap-3" autoComplete="off">
        <Field
          label="Shared team topic (optional)"
          name="url"
          type="url"
          defaultValue={s.url ?? ''}
          placeholder="https://ntfy.sh/pick-a-long-random-topic"
          disabled={!isAdmin}
          hint="Anyone who knows a topic on ntfy.sh can read it, so make the name long and random, or use your own server."
        />
        <SecretField
          label="Access token (if the topic needs one)"
          name="token"
          saved={s.hasToken}
          hint={s.hasToken ? 'Saved and encrypted.' : undefined}
          placeholder="tk_…"
          disabled={!isAdmin}
          reveal={isAdmin ? reveal('team') : undefined}
        />
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary">
              Save
            </button>
            {s.url && (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  setMessage(undefined);
                  try {
                    await api('/settings/notifications/test', { to: 'team' });
                    setMessage({ ok: true, text: 'Sent to the team topic.' });
                  } catch (err) {
                    setMessage({ ok: false, text: errorText(err, 'The test didn’t go through.') });
                  }
                }}
              >
                Test the team topic
              </button>
            )}
          </div>
        )}
        <Result message={message} />
      </form>
    </SenderCard>
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
  const [host, setHost] = useState(saved?.host ?? '');
  const [port, setPort] = useState(String(saved?.port ?? 587));
  const [security, setSecurity] = useState(saved?.security ?? 'starttls');
  const [user, setUser] = useState(saved?.user ?? '');
  const [note, setNote] = useState<string>();
  const [message, setMessage] = useState<Message>();
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    setMessage(undefined);
    setErrors({});
    try {
      await api(
        '/settings/notifications/email',
        {
          host: host.trim(),
          port: Number(port),
          security,
          user: user.trim(),
          ...(password && { password }),
          from: String(form.get('from') ?? '').trim(),
          fromName: String(form.get('fromName') ?? '').trim() || 'Social Switchboard',
        },
        'PUT',
      );
      await reload();
      setMessage({ ok: true, text: 'Saved. “Test email” in My alerts sends you one.' });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setMessage({ ok: false, text: errorText(err, 'Couldn’t save.') });
    }
  }

  return (
    <SenderCard title="Email (SMTP)" status={saved ? 'Set up' : 'Not set up'} ok={Boolean(saved)}>
      <p className="text-[14px] text-muted">
        Alerts go out through any email service that offers SMTP. Use an address on your own domain
        if you can, so alerts don’t land in spam.
      </p>
      {isAdmin ? (
        <form onSubmit={save} className="grid gap-3" autoComplete="off">
          <Select
            label="Service"
            value=""
            onChange={(e) => {
              const p = PRESETS.find((x) => x.name === e.target.value);
              if (!p) return;
              setHost(p.host);
              setPort(String(p.port));
              setSecurity(p.security);
              if (p.user) setUser(p.user);
              setNote(p.note);
            }}
            hint={note}
          >
            <option value="">Fill in from a common service…</option>
            {PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </Select>
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
            onChange={(e) => setSecurity(e.target.value as typeof security)}
          >
            <option value="starttls">STARTTLS (usually port 587)</option>
            <option value="tls">TLS from the start (usually port 465)</option>
            <option value="none">None (only for a server on your own network)</option>
          </Select>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Username"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              error={errors.user}
            />
            <SecretField
              label="Password"
              name="password"
              saved={Boolean(saved?.hasPassword)}
              hint={saved?.hasPassword ? 'Saved and encrypted.' : undefined}
              reveal={reveal('email')}
            />
            <Field
              label="From address"
              name="from"
              type="email"
              defaultValue={saved?.from ?? ''}
              placeholder="alerts@yourdomain.com"
              error={errors.from}
            />
            <Field
              label="From name"
              name="fromName"
              defaultValue={saved?.fromName ?? 'Social Switchboard'}
              error={errors.fromName}
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
                  if (!confirm('Turn off email alerts for everyone?')) return;
                  await api('/settings/notifications/email', undefined, 'DELETE');
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
