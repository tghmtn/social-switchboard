import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type FlowSummary, type InstagramMedia, type Starter, useApi } from '../api';
import { PostThumb } from '../builder/Triggers';
import { SquareIcon, type SquareIconName } from '../components/SquareIcons';
import { Dialog, EmptyState, Field, FormError, PageHeader, Toggle, timeAgo } from '../ui';
import { Page } from './Shell';

const STARTER_ICON: Record<string, SquareIconName> = {
  lead_magnet: 'sparkle',
  follow_first: 'check',
  welcome: 'chat',
  keyword_reply: 'flow',
  blank: 'board',
};

export function Automations() {
  const { data, loading, reload, setData } = useApi<{ flows: FlowSummary[] }>('/flows');
  const [params, setParams] = useSearchParams();
  const creating = params.get('new') === '1';
  const setCreating = (on: boolean) => setParams(on ? { new: '1' } : {}, { replace: true });
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<{ id: string; message: string }>();

  // Pictures of the posts their comment triggers watch, looked up together.
  const postIds = [...new Set(data?.flows.flatMap((f) => f.postIds) ?? [])].slice(0, 30);
  const lookup = useApi<{ media: InstagramMedia[] }>(
    postIds.length
      ? `/instagram/media/lookup?${new URLSearchParams({ ids: postIds.join(',') })}`
      : null,
  );
  const posts = new Map(lookup.data?.media.map((m) => [m.id, m]));

  // The copy opens in the builder, ready for its own keywords and name.
  async function duplicate(f: FlowSummary) {
    setBusy(f.id);
    setFailed(undefined);
    try {
      const res = await api<{ flow: { id: string } }>(`/flows/${f.id}/duplicate`, {});
      navigate(`/automations/${res.flow.id}`);
    } catch {
      setFailed({ id: f.id, message: 'Couldn’t duplicate this automation. Try again.' });
      setBusy(undefined);
    }
  }

  async function switchOn(f: FlowSummary, on: boolean) {
    setFailed(undefined);
    const flip = (value: boolean) =>
      setData((d) => d && { flows: d.flows.map((x) => (x.id === f.id ? { ...x, on: value } : x)) });
    flip(on);
    try {
      await api(`/flows/${f.id}`, { on }, 'PATCH');
    } catch {
      flip(!on);
      setFailed({ id: f.id, message: `Couldn’t switch it ${on ? 'on' : 'off'}. Try again.` });
    }
  }

  async function remove(f: FlowSummary) {
    if (
      !confirm(
        `Delete “${f.name}”? It stops answering right away, and anyone in the middle of it is dropped. Contacts and their conversations stay.`,
      )
    )
      return;
    setBusy(f.id);
    setFailed(undefined);
    try {
      await api(`/flows/${f.id}`, undefined, 'DELETE');
      await reload();
    } catch {
      setFailed({ id: f.id, message: 'Couldn’t delete this automation. Try again.' });
    }
    setBusy(undefined);
  }

  return (
    <Page>
      <PageHeader
        title="Automations"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New automation
          </button>
        }
      />

      {!loading && data?.flows.length === 0 && (
        <EmptyState
          icon="flow"
          title="No automations yet"
          body="An automation is a conversation that runs on its own: someone sends a keyword, the automation replies, asks questions, saves answers and hands off when a person is needed."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Build your first automation
            </button>
          }
        />
      )}

      <div className="grid gap-3 sm:gap-5 md:grid-cols-2">
        {data?.flows.map((f) => {
          const live = f.publishedNumber !== null;
          const cover = f.postIds[0];
          return (
            // The name's link covers the whole card; the controls at the bottom sit above it.
            <div key={f.id} className="card press relative flex gap-3 p-4 text-ink sm:gap-4 sm:p-6">
              {cover && (
                <div className="relative w-16 shrink-0 self-start sm:w-20">
                  {posts.get(cover) ? (
                    <PostThumb post={posts.get(cover)} className="w-full border-2 border-line" />
                  ) : (
                    <span className="flex aspect-[4/5] w-full items-center justify-center border-2 border-line bg-surface-2 text-[11px] text-muted">
                      {lookup.loading ? '' : 'Post'}
                    </span>
                  )}
                  {f.postIds.length > 1 && (
                    <span className="chip absolute -right-2 -bottom-2 bg-surface px-1.5 text-[11px]">
                      +{f.postIds.length - 1}
                    </span>
                  )}
                </div>
              )}
              <div className="grid min-w-0 flex-1 gap-2 sm:gap-3">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 text-[17px] font-bold break-words sm:text-lg">
                    <Link
                      to={`/automations/${f.id}`}
                      className="text-ink no-underline after:absolute after:inset-0"
                    >
                      {f.name}
                    </Link>
                  </h2>
                  {!live ? (
                    <span className="chip">Draft</span>
                  ) : !f.on ? (
                    <span className="chip">Off</span>
                  ) : f.hasUnpublishedChanges ? (
                    <span className="chip chip-orange">Unpublished changes</span>
                  ) : (
                    <span className="chip chip-success">Live · v{f.publishedNumber}</span>
                  )}
                </div>
                {/* Phones: the numbers on one line. */}
                <p className="text-[13px] text-muted sm:hidden">
                  {f.triggers} {f.triggers === 1 ? 'trigger' : 'triggers'} · {f.totalRuns}{' '}
                  {f.totalRuns === 1 ? 'run' : 'runs'}
                  {f.activeRuns ? ` · ${f.activeRuns} in progress` : ''} · edited{' '}
                  {timeAgo(f.updatedAt)}
                </p>
                <dl className="hidden grid-cols-3 gap-3 text-[13px] sm:grid">
                  <div>
                    <dt className="text-label uppercase text-muted">Triggers</dt>
                    <dd className="text-lg font-bold tabular-nums">{f.triggers}</dd>
                  </div>
                  <div>
                    <dt className="text-label uppercase text-muted">Runs</dt>
                    <dd className="text-lg font-bold tabular-nums">{f.totalRuns}</dd>
                  </div>
                  <div>
                    <dt className="text-label uppercase text-muted">In progress</dt>
                    <dd className="text-lg font-bold tabular-nums">{f.activeRuns}</dd>
                  </div>
                </dl>
                <p className="hidden text-[13px] text-muted sm:block">
                  Edited {timeAgo(f.updatedAt)}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {live && (
                    <span className="relative z-10 flex items-center gap-2 text-[13px] font-bold">
                      <Toggle
                        on={f.on}
                        label={`${f.name}: ${f.on ? 'on, answering' : 'off'}`}
                        onChange={(on) => switchOn(f, on)}
                      />
                      {f.on ? 'On' : 'Off'}
                    </span>
                  )}
                  <span className="relative z-10 ml-auto flex gap-2">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy !== undefined}
                      aria-label={`Duplicate ${f.name}`}
                      onClick={() => duplicate(f)}
                    >
                      {busy === f.id ? '…' : 'Duplicate'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm border-danger text-danger"
                      disabled={busy !== undefined}
                      aria-label={`Delete ${f.name}`}
                      onClick={() => remove(f)}
                    >
                      Delete
                    </button>
                  </span>
                </div>
                {failed?.id === f.id && <FormError message={failed.message} />}
              </div>
            </div>
          );
        })}
      </div>

      <NewFlowDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function NewFlowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useApi<{ starters: Starter[] }>('/flow-starters');
  const [starter, setStarter] = useState('lead_magnet');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const chosen = data?.starters.find((s) => s.key === starter);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ flow: { id: string } }>('/flows', {
        name: name || chosen?.name || 'New automation',
        starter,
      });
      navigate(`/automations/${res.flow.id}`);
    } catch {
      setError('Couldn’t create the automation. Try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New automation">
      <form onSubmit={create} className="grid gap-5">
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-3 text-label uppercase text-muted">Start from</legend>
          {data?.starters.map((s) => (
            <label
              key={s.key}
              className={`card press flex cursor-pointer gap-3 p-3.5 ${starter === s.key ? 'bg-surface-2 shadow-hard-lg' : ''}`}
            >
              <input
                type="radio"
                name="starter"
                value={s.key}
                checked={starter === s.key}
                onChange={() => setStarter(s.key)}
                className="sr-only"
              />
              <SquareIcon name={STARTER_ICON[s.key] ?? 'flow'} size={32} />
              <span>
                <span className="block font-bold">{s.name}</span>
                <span className="block text-[13px] leading-snug text-muted">{s.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field
          label="Name"
          name="name"
          placeholder={chosen?.name ?? 'New automation'}
          maxLength={100}
        />
        <FormError message={error} />
        <button type="submit" className="btn btn-primary w-fit" disabled={busy}>
          {busy ? 'Creating…' : 'Create and open'}
        </button>
      </form>
    </Dialog>
  );
}
