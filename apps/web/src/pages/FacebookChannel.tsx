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
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Avatar name={p.name ?? 'Page'} src={p.pictureUrl ?? undefined} />
                  <span className="grid flex-1">
                    <span className="font-bold">{p.name ?? p.pageId}</span>
                    <span className="text-[13px] text-muted">
                      Connected {timeAgo(p.connectedAt)}
                      {p.statusDetail ? ` · ${p.statusDetail}` : ''}
                    </span>
                  </span>
                  <span
                    className={`chip ${p.status === 'connected' ? 'chip-success' : 'chip-danger'}`}
                  >
                    {p.status === 'connected' ? 'Connected' : 'Needs reconnecting'}
                  </span>
                  <button
                    type="button"
                    className="linkbtn text-danger"
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

function StepItem({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-3">
      <span className="grid h-8 w-8 place-items-center border-2 border-edge font-bold">{n}</span>
      <div className="grid gap-2 text-[15px]">
        <h3 className="font-bold">{title}</h3>
        {children}
      </div>
    </li>
  );
}

/** Meta's side of the setup, with this install's values to copy. */
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
    <section className="card card-flat grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">Set up Facebook</h2>
        {onHide && (
          <button type="button" className="linkbtn" onClick={onHide}>
            Hide
          </button>
        )}
      </div>
      <p className="text-[14px] text-muted">
        Facebook uses the same Meta app as Instagram. Meta renames its menus now and then; if a name
        below doesn’t match, look for the closest one.
      </p>
      <ol className="grid gap-5">
        <StepItem n={1} title="Add Messenger and Facebook Login to your Meta app">
          <p>
            At{' '}
            <a
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noopener noreferrer"
            >
              developers.facebook.com/apps
            </a>
            , open your app and add the Messenger use case (“Engage with customers on Messenger from
            Meta”), plus Facebook Login (or Facebook Login for Business). It asks for these
            permissions:
          </p>
          <p className="flex flex-wrap gap-1.5">
            {s.scopes.map((x) => (
              <code key={x} className="border-2 border-line px-1.5 text-[13px]">
                {x}
              </code>
            ))}
          </p>
        </StepItem>
        <StepItem n={2} title="Allow this install’s login address">
          <p>
            In Facebook Login’s settings, add this to <b>Valid OAuth Redirect URIs</b>:
          </p>
          <CopyText text={s.urls.oauthRedirect} />
        </StepItem>
        <StepItem n={3} title="Paste the app’s details">
          <form onSubmit={save} className="grid gap-3" autoComplete="off">
            <Field
              label="Meta app ID"
              name="appId"
              inputMode="numeric"
              defaultValue={s.appId ?? ''}
              placeholder="App settings → Basic → App ID"
              hint={s.appId && !s.appIdSaved ? 'Taken from your Instagram Login URL.' : undefined}
              error={errors.appId}
            />
            <SecretField
              label="Meta app secret"
              name="appSecret"
              saved={s.hasAppSecret}
              hint={
                s.hasAppSecret
                  ? 'Saved and encrypted (the same one Instagram uses).'
                  : 'App settings → Basic → App secret.'
              }
              error={errors.appSecret}
            />
            <Field
              label="Login for Business configuration ID (only if your app uses one)"
              name="configId"
              inputMode="numeric"
              defaultValue={s.configId ?? ''}
              placeholder="Facebook Login for Business → Configurations"
              hint="Leave empty for classic Facebook Login. A configuration must include the permissions above."
              error={errors.configId}
            />
            <div className="flex items-center gap-3">
              <button type="submit" className="btn btn-primary btn-sm">
                Save
              </button>
              {saved && <span className="text-[13px] font-bold text-success">Saved</span>}
            </div>
          </form>
        </StepItem>
        <StepItem n={4} title="Send the Page’s events here">
          <p>
            In <b>Webhooks</b> (or Messenger → Settings → Webhooks), pick the <b>Page</b> object and
            use the same callback URL and verify token as Instagram:
          </p>
          <div className="grid gap-1.5">
            <span className="text-[13px] text-muted">Callback URL</span>
            <CopyText text={s.urls.webhook} />
            <span className="text-[13px] text-muted">Verify token</span>
            <CopyText text={s.webhookVerifyToken} />
          </div>
          <p>Then subscribe to these fields:</p>
          <p className="flex flex-wrap gap-1.5">
            {s.fields.map((x) => (
              <code key={x} className="border-2 border-line px-1.5 text-[13px]">
                {x}
              </code>
            ))}
          </p>
        </StepItem>
        <StepItem n={5} title="Connect your Pages">
          <p>
            Click <b>Connect Facebook</b>, log in, and choose the Pages. Connecting switches on each
            Page’s events for this app.
          </p>
          {s.appId && s.hasAppSecret ? (
            <a href="/api/facebook/connect" className="btn btn-primary w-fit">
              Connect Facebook
            </a>
          ) : (
            <p className="text-[14px] text-muted">Save the app ID and secret first.</p>
          )}
        </StepItem>
        <StepItem n={6} title="Test it">
          <p>
            From another Facebook account, comment a trigger keyword on one of the Page’s posts, or
            send the Page a message. Until Meta approves the app’s permissions (App Review), only
            people with a role on the app get answers, so add your test account as a tester.
          </p>
        </StepItem>
      </ol>
    </section>
  );
}
