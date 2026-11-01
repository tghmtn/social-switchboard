import {
  FacebookLogo,
  InstagramLogo,
  LinkedinLogo,
  type Icon as PhosphorIcon,
  TiktokLogo,
  YoutubeLogo,
} from '@phosphor-icons/react';
import { type FormEvent, Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useSearchParams } from 'react-router';
import {
  ApiError,
  api,
  type FacebookSettings,
  type Guide,
  type InstagramSettings,
  useApi,
} from '../api';
import { Icon } from '../components/Icon';
import { SquareIcon } from '../components/SquareIcons';
import { Avatar, Field, FormError, PageHeader, SecretField, timeAgo } from '../ui';
import { Page } from './Shell';

// Channels: the list, and the Instagram page (its setup at a glance, plus the Connect Instagram
// guide). The guide's words come from docs/guides/connect-instagram.md (fetched fresh from the
// project's repo when possible); the checks, forms and buttons are built in.

const LATER: { name: string; icon: PhosphorIcon; detail: string }[] = [
  { name: 'TikTok', icon: TiktokLogo, detail: 'Comment and DM automation for business accounts.' },
  { name: 'YouTube', icon: YoutubeLogo, detail: 'Replies to comments on your videos.' },
  { name: 'LinkedIn', icon: LinkedinLogo, detail: 'Page comments and messages.' },
];

export function Channels() {
  const { data: s } = useApi<InstagramSettings>('/instagram/settings');
  const { data: fb } = useApi<FacebookSettings>('/facebook/settings');
  const pages = fb?.pages.filter((p) => p.status === 'connected') ?? [];
  const connected = s?.accounts.filter((a) => a.status === 'connected') ?? [];
  const attention = s?.accounts.some((a) => a.status !== 'connected' || a.statusDetail);
  return (
    <Page>
      <PageHeader title="Channels" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          to="/channels/instagram"
          className="card press grid content-start gap-3 text-ink no-underline"
        >
          <span className="flex items-center gap-3">
            <Icon icon={InstagramLogo} size={40} />
            <span className="text-lg font-bold">Instagram</span>
          </span>
          <span className="text-[14px] text-muted">Comment-to-DM and DM keyword automation.</span>
          <span className="flex flex-wrap gap-2">
            <span className={`chip ${connected.length ? 'chip-success' : 'chip-orange'}`}>
              {connected.length
                ? `Connected: ${connected.map((a) => `@${a.username ?? a.igUserId}`).join(', ')}`
                : s?.loginMode
                  ? 'Setup in progress'
                  : 'Not set up'}
            </span>
            {attention && <span className="chip chip-danger">Needs attention</span>}
          </span>
        </Link>
        <Link
          to="/channels/facebook"
          className="card press grid content-start gap-3 text-ink no-underline"
        >
          <span className="flex items-center gap-3">
            <Icon icon={FacebookLogo} size={40} />
            <span className="text-lg font-bold">Facebook</span>
          </span>
          <span className="text-[14px] text-muted">
            Messenger and comments on your Page’s posts, on the same Meta app.
          </span>
          <span className="flex flex-wrap gap-2">
            <span className={`chip ${pages.length ? 'chip-success' : 'chip-orange'}`}>
              {pages.length
                ? `Connected: ${pages.map((p) => p.name ?? p.pageId).join(', ')}`
                : 'Not set up'}
            </span>
            {fb?.pages.some((p) => p.status !== 'connected') && (
              <span className="chip chip-danger">Needs attention</span>
            )}
          </span>
        </Link>
        {LATER.map((c) => (
          <div key={c.name} className="card grid content-start gap-3 opacity-75">
            <span className="flex items-center gap-3">
              <Icon icon={c.icon} size={40} />
              <span className="text-lg font-bold">{c.name}</span>
            </span>
            <span className="text-[14px] text-muted">{c.detail}</span>
            <span className="chip w-fit">Coming later</span>
          </div>
        ))}
      </div>
    </Page>
  );
}

type Step = { id: string; title: string; body: string };

function parseGuide(markdown: string): Step[] {
  return markdown
    .split(/^## step: /m)
    .slice(1)
    .map((chunk) => {
      const newline = chunk.indexOf('\n');
      const [id = '', title = ''] = chunk
        .slice(0, newline)
        .split('|')
        .map((s) => s.trim());
      return { id, title, body: chunk.slice(newline + 1).trim() };
    })
    .filter((s) => s.id && s.title);
}

const DONE_KEY = 'ss-instagram-wizard-done';
function loadDone(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Inline value with a copy button; falls back to selecting the text where the clipboard is blocked (plain http). */
export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-stretch border-2 border-edge bg-surface-2 align-middle">
      <code className="min-w-0 px-2 py-0.5 text-[13px] break-all select-all">{text}</code>
      <button
        type="button"
        className="shrink-0 border-l-2 border-edge px-2 text-[12px] font-bold hover:bg-surface"
        onClick={async (e) => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            const code = e.currentTarget.previousElementSibling;
            if (code) window.getSelection()?.selectAllChildren(code);
            return;
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function GuideText({ markdown }: { markdown: string }) {
  return (
    <div className="grid gap-3 text-[15px] [&_li]:ml-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ul]:list-disc [&_ul]:space-y-1">
      <Markdown
        components={{
          code: ({ children }) => <CopyText text={String(children)} />,
          blockquote: ({ children }) => (
            <div className="border-2 border-accent bg-surface px-3 py-2 text-[14px]">
              {children}
            </div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

function Check({ ok, okText, waitText }: { ok: boolean; okText: string; waitText: string }) {
  return ok ? (
    <p className="chip chip-success w-fit py-1">✓ {okText}</p>
  ) : (
    <p className="chip chip-orange w-fit py-1">{waitText}</p>
  );
}

export function InstagramChannel() {
  const settings = useApi<InstagramSettings>('/instagram/settings');
  const guide = useApi<Guide>('/guides/connect-instagram');
  const [params, setParams] = useSearchParams();
  const [done, setDone] = useState<string[]>(loadDone);
  const [open, setOpen] = useState<string>();
  // The guide is open until Instagram is set up; after that, on request.
  const [guideWanted, setGuideWanted] = useState<boolean>();
  const s = settings.data;

  const steps = useMemo(() => {
    if (!guide.data || !s) return [];
    const fill: Record<string, string> = {
      PUBLIC_URL: s.publicUrl,
      OAUTH_REDIRECT: s.urls.oauthRedirect,
      DEAUTHORIZE: s.urls.deauthorize,
      DATA_DELETION: s.urls.dataDeletion,
      WEBHOOK: s.urls.webhook,
      VERIFY_TOKEN: s.webhookVerifyToken,
      PRIVACY: s.urls.privacy,
      TERMS: s.urls.terms,
    };
    return parseGuide(
      guide.data.markdown.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => fill[k] ?? m),
    );
  }, [guide.data, s]);

  const connected = s?.accounts.filter((a) => a.status === 'connected') ?? [];
  const firstConnectedAt = connected.map((a) => a.connectedAt).sort()[0];
  const appMade = Boolean(s?.loginMode || s?.hasFacebookAppSecret);
  const proven: Record<string, boolean> = {
    account: connected.length > 0,
    developer: appMade,
    app: appMade,
    basics: Boolean(s?.hasFacebookAppSecret),
    login: Boolean(s?.loginMode),
    credentials: Boolean(s && canConnect(s)),
    tester: connected.length > 0,
    portfolio: connected.length > 0,
    webhooks: Boolean(s?.webhookVerifiedAt),
    connect: connected.length > 0,
    messages: Boolean(s?.lastSentAt),
    publish: Boolean(s?.lastWebhookAt && firstConnectedAt && s.lastWebhookAt > firstConnectedAt),
  };
  const isDone = (id: string) => proven[id] === true || done.includes(id);
  const setUp = connected.length > 0 && Boolean(s?.webhookVerifiedAt);
  const showGuide = guideWanted ?? !setUp;
  const nextStep = steps.find((st) => !isDone(st.id) && st.id !== 'manychat')?.id;
  const current = open ?? nextStep;

  // While waiting on Meta (webhook verification, the first real event), check back on our own.
  const waiting = showGuide && (current === 'webhooks' || current === 'publish');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void settings.reload(), 5000);
    return () => clearInterval(t);
  }, [waiting, settings.reload]);

  function toggleDone(id: string) {
    const next = done.includes(id) ? done.filter((d) => d !== id) : [...done, id];
    setDone(next);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify(next));
    } catch {}
    setOpen(undefined);
  }

  const banner = params.get('connected') ? (
    <p className="border-2 border-success bg-success-soft px-4 py-3 font-bold text-success">
      Connected @{params.get('connected')}. 🎉
    </p>
  ) : params.get('error') ? (
    <FormError message={params.get('error') ?? undefined} />
  ) : null;

  return (
    <Page>
      <Link to="/channels" className="linkbtn w-fit">
        ← Channels
      </Link>
      <div className="-mt-4">
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              <Icon icon={InstagramLogo} size={44} />
              Instagram
            </span>
          }
        />
      </div>
      {banner && (
        <div className="grid gap-2">
          {banner}
          <button
            type="button"
            className="linkbtn w-fit"
            onClick={() => setParams({}, { replace: true })}
          >
            Dismiss
          </button>
        </div>
      )}

      {s?.accountIdNeeded && <AccountIdForm onSaved={() => void settings.reload()} />}

      {s && (
        <Overview
          settings={s}
          onChange={() => void settings.reload()}
          guideShown={showGuide}
          onToggleGuide={() => setGuideWanted(!showGuide)}
        />
      )}

      {showGuide && (
        <section aria-labelledby="wizard-h" className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="wizard-h" className="font-display text-display-md font-bold">
                {connected.length ? 'Instagram setup' : 'Connect Instagram'}
              </h2>
              <p className="mt-1 text-[15px] text-muted">
                About 20 minutes the first time. Each step checks itself where it can.
              </p>
            </div>
            {guide.data && (
              <span className="text-[12px] text-muted">
                {guide.data.source === 'latest'
                  ? 'Guide: latest version'
                  : 'Guide: copy bundled with this version'}
              </span>
            )}
          </div>

          {s && !s.isPublic && (
            <p className="border-2 border-accent bg-surface px-4 py-3 text-[15px]">
              <b>This install isn’t on a public https address yet</b> (it’s set to {s.publicUrl}).
              Meta needs one to reach your webhooks. See “Serving it on a real domain” in the
              README, then set <code>PUBLIC_URL</code>.
            </p>
          )}

          <ol className="grid gap-3">
            {steps.map((st, i) => {
              const isOpen = current === st.id;
              const complete = isDone(st.id);
              const optional = st.id === 'manychat';
              return (
                <li
                  key={st.id}
                  className={`border-2 bg-surface ${isOpen ? 'border-edge shadow-hard' : 'border-line'}`}
                >
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? '' : st.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
                  >
                    {complete ? (
                      <SquareIcon name="check" size={28} label="Done" />
                    ) : (
                      <span className="flex size-7 shrink-0 items-center justify-center border-2 border-edge text-sm font-bold tabular-nums">
                        {i + 1}
                      </span>
                    )}
                    <span className="flex-1 font-bold">{st.title}</span>
                    {optional && !complete && <span className="chip">If needed</span>}
                    {!complete && !optional && st.id === nextStep && (
                      <span className="chip chip-orange">Next</span>
                    )}
                  </button>
                  {isOpen && s && (
                    <div className="grid gap-4 border-t-2 border-line px-4 py-4">
                      <GuideText markdown={st.body} />
                      <StepExtras
                        step={st.id}
                        settings={s}
                        onSaved={() => void settings.reload()}
                      />
                      {proven[st.id] === undefined || !proven[st.id] ? (
                        <button
                          type="button"
                          className="btn btn-sm w-fit"
                          onClick={() => toggleDone(st.id)}
                        >
                          {done.includes(st.id) ? 'Mark as not done' : 'I’ve done this'}
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {guide.error && <FormError message="Couldn’t load the setup guide." />}
        </section>
      )}
    </Page>
  );
}

/** The top of the Instagram page: connected accounts and every saved setting, checked. */
function Overview({
  settings: s,
  onChange,
  guideShown,
  onToggleGuide,
}: {
  settings: InstagramSettings;
  onChange: () => void;
  guideShown: boolean;
  onToggleGuide: () => void;
}) {
  const connected = s.accounts.filter((a) => a.status === 'connected');
  const blocked = connected.some((a) => a.statusDetail?.includes('Allow access to messages'));
  const rows: { label: string; ok: boolean | null; value: ReactNode }[] = [
    {
      label: 'Login',
      ok: Boolean(s.loginMode),
      value:
        s.loginMode === 'unified'
          ? `Unified login · Meta app ${s.metaAppId} · configuration ${s.configId}`
          : s.loginMode === 'instagram'
            ? `Instagram login · app ${s.instagramAppId}`
            : 'Not set up yet',
    },
    {
      label: 'Meta app secret',
      ok: s.hasFacebookAppSecret,
      value: s.hasFacebookAppSecret ? 'Saved, encrypted' : 'Not saved',
    },
    {
      label: 'Webhooks',
      ok: Boolean(s.webhookVerifiedAt),
      value: s.webhookVerifiedAt
        ? `Verified by Meta ${timeAgo(s.webhookVerifiedAt)}`
        : 'Not verified yet',
    },
    {
      label: 'Sending DMs',
      ok: blocked ? false : s.lastSentAt ? true : null,
      value: blocked
        ? 'Instagram is blocking DMs from apps: see the account above'
        : s.lastSentAt
          ? `Instagram accepted a DM ${timeAgo(s.lastSentAt)}`
          : 'No DM sent yet',
    },
    {
      label: 'Events',
      ok: s.lastWebhookAt ? true : null,
      value: s.lastWebhookAt
        ? `Last comment or message from Instagram ${timeAgo(s.lastWebhookAt)}`
        : 'Nothing received yet',
    },
  ];
  const mark = (ok: boolean | null) =>
    ok === true ? (
      <span className="text-success">✓</span>
    ) : ok === false ? (
      <span className="text-danger">✕</span>
    ) : (
      <span className="text-muted">•</span>
    );

  return (
    <section aria-label="Instagram setup" className="grid gap-4">
      {s.accounts.map((a) => (
        <div key={a.id} className="card flex flex-wrap items-center gap-4">
          <Avatar
            name={a.username ?? a.igUserId}
            size={48}
            src={a.profilePictureUrl ?? undefined}
          />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-bold">@{a.username ?? a.igUserId}</p>
            <p className="text-[13px] text-muted">
              {a.accountType === 'MEDIA_CREATOR'
                ? 'Creator'
                : a.accountType === 'BUSINESS'
                  ? 'Business'
                  : 'Professional'}{' '}
              account · connected {timeAgo(a.connectedAt)}
            </p>
            {a.statusDetail && (
              <p className="mt-1 text-[13px] font-bold text-danger">{a.statusDetail}</p>
            )}
          </div>
          <span className={`chip ${a.status === 'connected' ? 'chip-success' : 'chip-danger'}`}>
            {a.status === 'connected' ? 'Connected' : 'Needs attention'}
          </span>
          {a.status !== 'connected' && (
            <a className="btn btn-sm" href="/api/instagram/connect">
              Reconnect
            </a>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              if (
                !confirm(
                  `Disconnect @${a.username}? Flows stop answering on this account until you connect it again. Contacts and history stay.`,
                )
              )
                return;
              await api(`/instagram/accounts/${a.id}`, undefined, 'DELETE');
              onChange();
            }}
          >
            Disconnect
          </button>
        </div>
      ))}

      <div className="card grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-display-sm font-bold">Setup</h2>
          <div className="flex flex-wrap gap-2">
            {canConnect(s) && (
              <a className="btn btn-sm" href="/api/instagram/connect">
                {connected.length ? 'Connect another account' : 'Connect Instagram'}
              </a>
            )}
            <button type="button" className="btn btn-sm" onClick={onToggleGuide}>
              {guideShown ? 'Hide setup guide' : 'Show setup guide'}
            </button>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px]">
          {rows.map((r) => (
            <Fragment key={r.label}>
              <dt className="flex items-center gap-2 font-bold">
                {mark(r.ok)} {r.label}
              </dt>
              <dd className="break-words text-muted">{r.value}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="text-[13px] text-muted">
          To change a setting, open the setup guide: each step has its own form.
        </p>
      </div>
    </section>
  );
}

/** The live parts of a step: forms, buttons and checks. */
function StepExtras({
  step,
  settings: s,
  onSaved,
}: {
  step: string;
  settings: InstagramSettings;
  onSaved: () => void;
}): ReactNode {
  const connected = s.accounts.filter((a) => a.status === 'connected');
  switch (step) {
    case 'basics':
      return <CredentialsForm settings={s} onSaved={onSaved} secret />;
    case 'login':
      return <CredentialsForm settings={s} onSaved={onSaved} login />;
    case 'credentials': // guides from before the steps followed Meta's page
      return <CredentialsForm settings={s} onSaved={onSaved} secret login />;
    case 'webhooks':
      return (
        <Check
          ok={Boolean(s.webhookVerifiedAt)}
          okText={`Meta verified your webhook ${timeAgo(s.webhookVerifiedAt)}`}
          waitText="Waiting for Meta to verify… (checks every few seconds)"
        />
      );
    case 'connect': {
      return (
        <div className="grid gap-3">
          {canConnect(s) ? (
            <a className="btn btn-primary w-fit" href="/api/instagram/connect">
              {connected.length ? 'Connect another account' : 'Connect Instagram'}
            </a>
          ) : (
            <p className="text-[14px] text-muted">Save your Login URL and Meta app secret first.</p>
          )}
          <Check
            ok={connected.length > 0}
            okText={`Connected as ${connected.map((a) => `@${a.username}`).join(', ')}`}
            waitText="Not connected yet"
          />
        </div>
      );
    }
    case 'messages': {
      const blocked = connected.filter((a) => a.statusDetail?.includes('Allow access to messages'));
      return blocked.length > 0 ? (
        <p className="border-2 border-danger px-3 py-2 text-[14px] font-bold text-danger">
          Instagram is still blocking DMs from apps on{' '}
          {blocked.map((a) => `@${a.username ?? a.igUserId}`).join(', ')}. Turn the switch on, then
          try again (a new comment, or a new message to you).
        </p>
      ) : (
        <Check
          ok={Boolean(s.lastSentAt)}
          okText={`Instagram accepted a DM from Social Switchboard ${timeAgo(s.lastSentAt)}`}
          waitText="Checked when the first DM goes out (the “Try it” step sends one)"
        />
      );
    }
    case 'publish':
      return (
        <Check
          ok={Boolean(
            s.lastWebhookAt && connected[0] && s.lastWebhookAt > connected[0].connectedAt,
          )}
          okText={`A real event from Instagram arrived ${timeAgo(s.lastWebhookAt)}`}
          waitText="Waiting for a real event (try commenting on one of your posts)"
        />
      );
    default:
      return null;
  }
}

/** Everything the Connect button needs: a way to log in, and the secret to finish it with. */
function canConnect(s: InstagramSettings) {
  if (s.loginMode === 'unified') return s.hasFacebookAppSecret;
  return s.loginMode === 'instagram' && s.hasInstagramAppSecret;
}

const ACCOUNT_ID_ERRORS: Record<string, string> = {
  not_shared:
    'Meta says your login didn’t share that account. Check the number, or click Connect Instagram again and pick the account.',
  login_needed: 'That login has timed out. Click Connect Instagram again.',
  other_workspace: 'That account is already connected to another workspace.',
};

/** Meta's login didn't say which Instagram account was shared: the ID Meta shows the owner does. */
function AccountIdForm({ onSaved }: { onSaved: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const igUserId = String(new FormData(e.currentTarget).get('igUserId') ?? '').trim();
    setBusy(true);
    setError(undefined);
    try {
      await api('/instagram/accounts/by-id', { igUserId });
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.fieldErrors().igUserId ??
              ACCOUNT_ID_ERRORS[err.code] ??
              'Couldn’t connect it. Try again in a minute.')
          : 'Couldn’t connect it. Try again in a minute.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="account-id-h" className="card grid gap-3 border-accent">
      <h2 id="account-id-h" className="text-lg font-bold">
        One more step: which Instagram account?
      </h2>
      <p className="text-[15px]">
        You logged in, but Meta didn’t tell Social Switchboard which Instagram account you shared.
        Open{' '}
        <a
          href="https://business.facebook.com/latest/settings/connected_apps"
          target="_blank"
          rel="noreferrer"
        >
          Business settings → Connected apps
        </a>
        , click your app, and under <b>Instagram accounts</b> copy the <b>ID</b> below the account
        name.
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3" autoComplete="off">
        <Field
          label="Instagram account ID"
          name="igUserId"
          inputMode="numeric"
          required
          placeholder="17841400000000000"
        />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Connect this account
        </button>
      </form>
      <FormError message={error} />
    </section>
  );
}

const revealSecret = async (field: 'facebookAppSecret' | 'instagramAppSecret') =>
  (await api<{ value: string }>('/instagram/settings/reveal', { field })).value;

/** Saves what Meta shows on the current step: the app secret, the Login URL, or both. */
function CredentialsForm({
  settings: s,
  onSaved,
  secret = false,
  login = false,
}: {
  settings: InstagramSettings;
  onSaved: () => void;
  secret?: boolean;
  login?: boolean;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const body: Record<string, string> = {};
    for (const key of ['loginUrl', 'facebookAppSecret', 'instagramAppId', 'instagramAppSecret']) {
      const v = String(form.get(key) ?? '').trim();
      if (v) body[key] = v;
    }
    setBusy(true);
    setErrors({});
    setSaved(false);
    try {
      await api('/instagram/settings', body, 'PUT');
      formEl.reset();
      setSaved(true);
      onSaved();
    } catch (err) {
      setErrors(
        err instanceof ApiError
          ? err.fieldErrors()
          : { [login ? 'loginUrl' : 'facebookAppSecret']: 'Couldn’t save. Try again.' },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3 border-2 border-line p-4" autoComplete="off">
      {login && (
        <>
          <Field
            label="Login URL"
            name="loginUrl"
            inputMode="url"
            defaultValue={s.loginUrl ?? ''}
            placeholder="https://www.facebook.com/dialog/oauth?client_id=…&config_id=…"
            hint={s.loginUrl ? `Saved (configuration ${s.configId}).` : undefined}
            error={errors.loginUrl}
          />
          {s.loginRedirectMatches === false && (
            <p className="border-2 border-accent bg-surface px-3 py-2 text-[13px]">
              That Login URL sends people to a different address after they log in. In the same
              configuration, register <code>{s.urls.oauthRedirect}</code> as a redirect URL.
            </p>
          )}
        </>
      )}
      {secret && (
        <SecretField
          label="Meta app secret"
          name="facebookAppSecret"
          saved={s.hasFacebookAppSecret}
          hint={s.hasFacebookAppSecret ? 'Saved and encrypted.' : undefined}
          error={errors.facebookAppSecret}
          reveal={() => revealSecret('facebookAppSecret')}
        />
      )}
      {login && (
        <details className="border-2 border-line px-3 py-2">
          <summary className="cursor-pointer text-[14px] font-bold">
            Older app with “API setup with Instagram login”?
          </summary>
          <div className="mt-3 grid gap-3">
            <p className="text-[13px] text-muted">
              Apps made before mid-2026 may have this instead of Unified login. Copy the ID and
              secret from that page instead of a Login URL.
            </p>
            <Field
              label="Instagram app ID"
              name="instagramAppId"
              inputMode="numeric"
              defaultValue={s.instagramAppId ?? ''}
              placeholder="e.g. 1234567890123456"
              error={errors.instagramAppId}
            />
            <SecretField
              label="Instagram app secret"
              name="instagramAppSecret"
              saved={s.hasInstagramAppSecret}
              hint={s.hasInstagramAppSecret ? 'Saved and encrypted.' : undefined}
              error={errors.instagramAppSecret}
              reveal={() => revealSecret('instagramAppSecret')}
            />
          </div>
        </details>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          Save
        </button>
        {saved && (
          <span className="text-[13px] font-bold text-success">
            {secret ? 'Saved and encrypted' : 'Saved'}
          </span>
        )}
      </div>
    </form>
  );
}
