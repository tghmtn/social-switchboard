import { FacebookLogo } from '@phosphor-icons/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, api, type FacebookSettings, useApi } from '../api';
import { Icon } from '../components/Icon';
import { Avatar, Field, FormError, PageHeader, SecretField, timeAgo } from '../ui';
import { CopyText } from './Channels';
import { Page } from './Shell';

// The Facebook channel: connected Pages (Messenger and comments on their posts), Facebook Login
// with the same Meta app as Instagram, picking Pages, and the setup steps on Meta's side.

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? (Object.values(err.fieldErrors())[0] ?? (err.code.includes(' ') ? err.code : fallback))
    : fallback;

export function FacebookChannel() {
  const settings = useApi<FacebookSettings>('/facebook/settings');
  const [params] = useSearchParams();
  const s = settings.data;
  const connected = s?.pages.filter((p) => p.status === 'connected') ?? [];
  const [setupWanted, setSetupWanted] = useState<boolean>();
  const showSetup = setupWanted ?? connected.length === 0;
  const ready = Boolean(s?.appId && s.hasAppSecret);
  const choosing = s?.pending.some((p) => !p.connected);

  return (
    <Page>
      <Link to="/channels" className="linkbtn w-fit">
        ← Channels
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Icon icon={FacebookLogo} size={44} />
            Facebook
          </span>
        }
        actions={
          ready ? (
            <a href="/api/facebook/connect" className="btn btn-primary">
              {connected.length ? 'Connect another Page' : 'Connect Facebook'}
            </a>
          ) : undefined
        }
      />
      {params.get('connected') ? (
        <p className="border-2 border-success bg-success-soft px-4 py-3 font-bold text-success">
          Connected {params.get('connected')}. 🎉
        </p>
      ) : params.get('error') ? (
        <FormError message={params.get('error') ?? undefined} />
      ) : null}

      {s && choosing && <PagePicker settings={s} onDone={(next) => settings.setData(next)} />}

      {s && (
        <section className="card card-flat grid gap-3">
          <h2 className="font-bold">Pages</h2>
          <p className="text-[14px] text-muted">
            Messages to a connected Page and comments on its posts run your flows, the same as
            Instagram: comment triggers answer with a private reply in Messenger.
          </p>
          {s.pages.length === 0 ? (
            <p className="text-[15px]">
              No Page is connected yet.{' '}
              {ready ? 'Click Connect Facebook.' : 'Follow the setup steps below first.'}
            </p>
          ) : (
            <ul className="grid divide-y-2 divide-line border-2 border-edge">
              {s.pages.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <Avatar name={p.name ?? 'Page'} src={p.pictureUrl ?? undefined} />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-bold">{p.name ?? p.pageId}</span>
                      <span
                        className={`chip ${p.status === 'connected' ? 'chip-success' : 'chip-danger'}`}
                      >
                        {p.status === 'connected' ? 'Connected' : 'Needs reconnecting'}
                      </span>
                    </span>
                    <span className="text-[13px] text-muted">
                      Connected {timeAgo(p.connectedAt)}
                      {p.statusDetail ? ` · ${p.statusDetail}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm w-full text-danger sm:w-auto"
                    onClick={async () => {
                      if (
                        !confirm(
                          `Disconnect ${p.name ?? 'this Page'}? Its messages and comments stop arriving.`,
                        )
                      )
                        return;
                      settings.setData(
                        await api<FacebookSettings>(`/facebook/pages/${p.id}`, undefined, 'DELETE'),
                      );
                    }}
                  >
                    Disconnect
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 text-[13px] text-muted">
            <span>
              Webhooks:{' '}
              {s.webhookVerifiedAt
                ? `verified ${timeAgo(s.webhookVerifiedAt)}`
                : 'not verified yet'}
            </span>
            <span>·</span>
            <span>
              Last event from Meta: {s.lastWebhookAt ? timeAgo(s.lastWebhookAt) : 'none yet'}
            </span>
          </div>
          {!showSetup && (
            <button type="button" className="linkbtn w-fit" onClick={() => setSetupWanted(true)}>
              Show the setup steps
            </button>
          )}
        </section>
      )}

      {s && showSetup && (
        <Setup
          settings={s}
          onSaved={(next) => settings.setData(next)}
          onHide={connected.length ? () => setSetupWanted(false) : undefined}
        />
      )}
    </Page>
  );
}

/** Pages the last Facebook login shared, to pick from. */
function PagePicker({
  settings: s,
  onDone,
}: {
  settings: FacebookSettings;
  onDone: (s: FacebookSettings) => void;
}) {
  const choosable = s.pending.filter((p) => !p.connected);
  const [picked, setPicked] = useState<Set<string>>(new Set(choosable.map((p) => p.id)));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <section className="card grid gap-3 border-primary">
      <h2 className="font-bold">Which Pages should Social Switchboard answer for?</h2>
      <ul className="grid gap-2">
        {s.pending.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={p.connected || picked.has(p.id)}
                disabled={p.connected}
                onChange={() =>
                  setPicked((was) => {
                    const next = new Set(was);
                    if (next.has(p.id)) next.delete(p.id);
                    else next.add(p.id);
                    return next;
                  })
                }
              />
              <Avatar name={p.name} src={p.picture ?? undefined} />
              <span className="font-bold">{p.name}</span>
              {p.connected && <span className="chip">Already connected</span>}
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-primary w-fit"
        disabled={busy || picked.size === 0}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            const r = await api<FacebookSettings & { failed: string[] }>('/facebook/pages', {
              pageIds: [...picked],
            });
            if (r.failed.length) setError(r.failed.join(' '));
            onDone(r);
          } catch (err) {
            setError(errorText(err, 'Couldn’t connect them.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        Connect {picked.size === 1 ? 'this Page' : `${picked.size} Pages`}
      </button>
      <FormError message={error} />
    </section>
  );
}

function StepItem({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  /** Shows a tick when the app can tell this step is done. */
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-3">
      <span
        className={`grid h-8 w-8 place-items-center border-2 font-bold ${done ? 'border-success bg-success-soft text-success' : 'border-edge'}`}
        aria-hidden
      >
        {done ? '✓' : n}
      </span>
      <div className="grid gap-2 text-[15px]">
        <h3 className="font-bold">
          <span className="sr-only">Step {n}: </span>
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h3>
        {children}
      </div>
    </li>
  );
}

/** A menu path in Meta's screens, like Use cases → Customize. */
const Path = ({ children }: { children: ReactNode }) => (
  <b className="whitespace-normal">{children}</b>
);

const Chips = ({ items }: { items: string[] }) => (
  <p className="flex flex-wrap gap-1.5">
    {items.map((x) => (
      <code key={x} className="border-2 border-line px-1.5 text-[13px]">
        {x}
      </code>
    ))}
  </p>
);

/**
 * Meta's side of the setup, written for someone who has never used Meta's developer tools, with
 * this install's values to copy and a tick on each step the app can confirm.
 */
function Setup({
  settings: s,
  onSaved,
  onHide,
}: {
  settings: FacebookSettings;
  onSaved: (s: FacebookSettings) => void;
  onHide?: () => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const connected = s.pages.some((p) => p.status === 'connected');

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const appId = String(form.get('appId') ?? '').trim();
    const configId = String(form.get('configId') ?? '').trim();
    const appSecret = String(form.get('appSecret') ?? '').trim();
    setErrors({});
    setSaved(false);
    try {
      onSaved(
        await api<FacebookSettings>(
          '/facebook/settings',
          {
            ...(appId && appId !== s.appId ? { appId } : {}),
            configId: configId || null,
            ...(appSecret && { appSecret }),
          },
          'PUT',
        ),
      );
      setSaved(true);
    } catch (err) {
      setErrors(err instanceof ApiError ? err.fieldErrors() : { appId: 'Couldn’t save.' });
    }
  }

  return (
    <section className="card card-flat grid gap-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">Set up Facebook</h2>
        {onHide && (
          <button type="button" className="linkbtn" onClick={onHide}>
            Hide
          </button>
        )}
      </div>
      <p className="text-[15px]">
        About 15 minutes, all in your browser. Facebook uses the same Meta app you made for
        Instagram, so some of it is already done. Meta renames its menus now and then: if a name
        below doesn’t match exactly, look for the closest one.
      </p>

      <ol className="grid gap-6">
        <StepItem n={1} title="Have a Facebook Page (not just your profile)" done={connected}>
          <p>
            Your <b>profile</b> is you as a person: friends, your own posts. A <b>Page</b> is a
            separate public presence for a business, brand or creator, with followers, its own
            inbox, and its own address. Facebook only lets apps answer messages and comments for
            Pages, never for profiles. (Professional mode on a profile doesn’t count.)
          </p>
          <p>
            No Page yet? At{' '}
            <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer">
              business.facebook.com
            </a>{' '}
            go to <Path>Settings → Accounts → Pages → Add → Create a new Page</Path>. Making it
            there puts it in your business portfolio with you in full control. (Or use{' '}
            <a
              href="https://www.facebook.com/pages/create"
              target="_blank"
              rel="noopener noreferrer"
            >
              facebook.com/pages/create
            </a>
            .) Then post anything on it, so there’s a post to comment on when you test.
          </p>
        </StepItem>

        <StepItem n={2} title="Add Messenger to your Meta app">
          <p>
            At{' '}
            <a
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noopener noreferrer"
            >
              developers.facebook.com/apps
            </a>
            , open your app (the one you made for Instagram). Go to{' '}
            <Path>Use cases → Add use case</Path> and add <b>Messenger from Meta</b> (“Engage with
            customers on Messenger from Meta”).
          </p>
        </StepItem>

        <StepItem
          n={3}
          title="Send Facebook’s events to Switchboard (webhooks)"
          done={Boolean(s.webhookVerifiedAt)}
        >
          <p>
            Still in your app:{' '}
            <Path>Use cases → Messenger from Meta → Customize → Messenger API Settings</Path>, step{' '}
            <b>1. Configure webhooks</b>. Paste these two values and click <b>Verify and save</b>:
          </p>
          <div className="grid gap-1.5">
            <span className="text-[13px] text-muted">
              Callback URL: the <b>webhook</b> address (the same one Instagram uses)
            </span>
            <CopyText text={s.urls.webhook} />
            <span className="text-[13px] text-muted">Verify token</span>
            <CopyText text={s.webhookVerifyToken} />
          </div>
          <p>Then subscribe to these fields (feed is the one that carries comments):</p>
          <Chips items={s.fields} />
          <p className="text-[14px] text-muted">
            Skip <b>2. Generate access tokens</b> on that screen: Switchboard gets the Page’s token
            itself when you connect in step 6.
          </p>
        </StepItem>

        <StepItem n={4} title="Let Facebook Login send you back here">
          <p>
            In the left menu: <Path>Facebook Login for Business → Settings</Path>. In{' '}
            <b>Valid OAuth Redirect URIs</b>, add this next to the Instagram address already there,
            then click <b>Save Changes</b>:
          </p>
          <span className="text-[13px] text-muted">
            The <b>login</b> address (this is not the webhook address)
          </span>
          <CopyText text={s.urls.oauthRedirect} />
        </StepItem>

        <StepItem n={5} title="Create a login configuration" done={Boolean(s.configId)}>
          <p>
            <Path>Facebook Login for Business → Configurations → Create configuration</Path>. Name
            it (“Switchboard Pages”), and when it asks:
          </p>
          <ul className="ml-5 grid list-disc gap-1">
            <li>
              Access token: <b>User access token</b> (not “system-user”, which can’t see your
              Pages).
            </li>
            <li>
              Assets: <b>Pages</b>.
            </li>
            <li>Permissions: these ones.</li>
          </ul>
          <Chips items={s.scopes} />
          <p className="text-[14px] text-muted">
            <code>pages_manage_engagement</code> lets flows post a public reply under a comment;
            without it, the private reply in Messenger still works.
          </p>
          <p>Copy the new configuration’s ID into the form below.</p>
          <form onSubmit={save} className="grid gap-3 border-2 border-line p-3" autoComplete="off">
            <Field
              label="Configuration ID"
              name="configId"
              inputMode="numeric"
              defaultValue={s.configId ?? ''}
              placeholder="e.g. 2017649358934015"
              error={errors.configId}
            />
            <Field
              label="Meta app ID"
              name="appId"
              inputMode="numeric"
              defaultValue={s.appId ?? ''}
              placeholder="App settings → Basic → App ID"
              hint={
                s.appId && !s.appIdSaved
                  ? 'Already filled in from your Instagram setup.'
                  : 'App settings → Basic → App ID.'
              }
              error={errors.appId}
            />
            <SecretField
              label="Meta app secret"
              name="appSecret"
              saved={s.hasAppSecret}
              hint={
                s.hasAppSecret
                  ? 'Already saved from your Instagram setup.'
                  : 'App settings → Basic → App secret.'
              }
              error={errors.appSecret}
            />
            <div className="flex items-center gap-3">
              <button type="submit" className="btn btn-primary btn-sm">
                Save
              </button>
              {saved && <span className="text-[13px] font-bold text-success">Saved</span>}
            </div>
          </form>
        </StepItem>

        <StepItem n={6} title="Connect your Page" done={connected}>
          <p>
            Click <b>Connect Facebook</b> and log in. When Facebook asks which Pages to share, tick
            your Page. You come back here with it connected (or a list to pick from if you have
            several).
          </p>
          {s.appId && s.hasAppSecret ? (
            <a href="/api/facebook/connect" className="btn btn-primary w-fit">
              Connect Facebook
            </a>
          ) : (
            <p className="text-[14px] text-muted">Save the app ID and secret first.</p>
          )}
        </StepItem>

        <StepItem n={7} title="Test it" done={connected && Boolean(s.lastWebhookAt)}>
          <p>
            Add a comment trigger (on any post, or a Page post) to a published flow. Then, from{' '}
            <b>another</b> Facebook account, comment the keyword on a Page post. They should get a
            private reply in Messenger from the Page, and replying continues the flow.
          </p>
          <p className="text-[14px] text-muted">
            Until Meta reviews the app (App Review), it may only answer people with a role on it:
            add test accounts under <Path>App roles → Roles</Path> in your Meta app.
          </p>
        </StepItem>
      </ol>

      <details className="border-2 border-line px-4 py-3">
        <summary className="cursor-pointer font-bold">Stuck? The usual problems</summary>
        <dl className="mt-3 grid gap-3 text-[14px]">
          <div>
            <dt className="font-bold">“The callback URL or verify token couldn’t be validated”</dt>
            <dd className="text-muted">
              The Callback URL is probably the login address. Use the webhook address from step 3
              (ending in /webhook), with the verify token shown there.
            </dd>
          </div>
          <div>
            <dt className="font-bold">“Facebook didn’t share any Pages”</dt>
            <dd className="text-muted">
              Usually there’s no Page yet (only a profile), or the Page wasn’t ticked during login.
              See step 1, then connect again. If Meta’s own <b>Generate access tokens → Connect</b>{' '}
              also shows no Pages, it’s the Page’s access, not Switchboard.
            </dd>
          </div>
          <div>
            <dt className="font-bold">A comment got no reply</dt>
            <dd className="text-muted">
              Check that the flow is published, its comment trigger isn’t limited to an Instagram
              post, the commenter has a role on the app (until App Review), and webhooks are
              subscribed to <code>feed</code>.
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
