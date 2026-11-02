import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type FlowSummary, type Starter, useApi } from '../api';
import { SquareIcon, type SquareIconName } from '../components/SquareIcons';
import { Dialog, EmptyState, Field, FormError, PageHeader, timeAgo } from '../ui';
import { Page } from './Shell';

const STARTER_ICON: Record<string, SquareIconName> = {
  lead_magnet: 'sparkle',
  follow_first: 'check',
  welcome: 'chat',
  keyword_reply: 'flow',
  blank: 'board',
};

export function Automations() {
  const { data, loading } = useApi<{ flows: FlowSummary[] }>('/flows');
  const [params, setParams] = useSearchParams();
  const creating = params.get('new') === '1';
  const setCreating = (on: boolean) => setParams(on ? { new: '1' } : {}, { replace: true });

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
        {data?.flows.map((f) => (
          <Link
            key={f.id}
            to={`/automations/${f.id}`}
            className="card press grid gap-2 p-4 text-ink no-underline sm:gap-3 sm:p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 text-[17px] font-bold break-words sm:text-lg">{f.name}</h2>
              {f.publishedNumber === null ? (
                <span className="chip">Draft</span>
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
              {f.activeRuns ? ` · ${f.activeRuns} in progress` : ''} · edited {timeAgo(f.updatedAt)}
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
            <p className="hidden text-[13px] text-muted sm:block">Edited {timeAgo(f.updatedAt)}</p>
          </Link>
        ))}
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
