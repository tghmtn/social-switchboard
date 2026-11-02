import { type FormEvent, useState } from 'react';
import {
  type AiModelList,
  type AiProvider,
  type AiSettings,
  type AiUsage,
  ApiError,
  api,
  type Me,
  useApi,
} from '../api';
import { ProviderLogo } from '../components/ProviderLogo';
import { FormError, SecretField, Select, timeAgo } from '../ui';

// Settings → AI: bring your own key from Anthropic or OpenAI (save both, pick the one in use),
// the model from the provider's live list, and what the AI has used and done.

const EFFORT_HELP: Record<string, string> = {
  low: 'Quick answers, fewest tokens.',
  medium: 'Balanced (the default).',
  high: 'Thinks harder; best for building bigger automations. Uses more tokens.',
};

const PROVIDER_INFO: Record<
  AiProvider,
  { name: string; keyPlaceholder: string; console: string; consoleUrl: string }
> = {
  anthropic: {
    name: 'Anthropic (Claude)',
    keyPlaceholder: 'sk-ant-…',
    console: 'console.anthropic.com',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    name: 'OpenAI',
    keyPlaceholder: 'sk-…',
    console: 'platform.openai.com',
    consoleUrl: 'https://platform.openai.com/api-keys',
  },
};

const dollars = (n: number) => (n < 0.01 ? (n > 0 ? '< $0.01' : '$0.00') : `$${n.toFixed(2)}`);
const thousands = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? (Object.values(err.fieldErrors())[0] ?? (err.code.includes(' ') ? err.code : fallback))
    : fallback;

export function AiSection({ me }: { me: Me }) {
  const settings = useApi<AiSettings>('/settings/ai');
  const usage = useApi<AiUsage>('/settings/ai/usage');
  const role = me.workspaces[0]?.role;
  const canEdit = role === 'owner' || role === 'admin';
  const [switchError, setSwitchError] = useState<string>();

  const s = settings.data;
  const known = usage.data?.models.filter((m) => m.estimatedCost !== null) ?? [];
  const unknown = usage.data?.models.filter((m) => m.estimatedCost === null) ?? [];
  const total = known.reduce((sum, m) => sum + (m.estimatedCost ?? 0), 0);

  async function choose(change: { provider?: AiProvider; effort?: string }) {
    setSwitchError(undefined);
    try {
      settings.setData(await api<AiSettings>('/settings/ai', change, 'PUT'));
    } catch (err) {
      setSwitchError(errorText(err, 'Couldn’t save.'));
    }
  }

  return (
    <section aria-labelledby="ai-h" className="grid gap-4">
      <div>
        <h2 id="ai-h" className="font-display text-display-sm font-bold">
          AI
        </h2>
        <p className="mt-1 text-[15px] text-muted">
          The assistant (✨ in the menu), AI steps in automations, and ✨ Suggest in the Inbox run
          on your own API key from Anthropic or OpenAI. Save one or both and pick the one in use.
          The provider bills your key directly; nothing goes through anyone else.
        </p>
      </div>

      {s && (
        <>
          <div className="card card-flat grid gap-3">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-bold">In use</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {s.providers.map((p) => {
                  const on = s.provider === p.id;
                  const ok = s[p.id].hasKey && Boolean(s[p.id].model);
                  return (
                    <label
                      key={p.id}
                      className={`flex cursor-pointer items-center gap-3 border-2 px-3 py-2.5 ${on ? 'border-edge bg-surface-2' : 'border-line'} ${canEdit ? '' : 'cursor-default'}`}
                    >
                      <input
                        type="radio"
                        name="provider"
                        checked={on}
                        disabled={!canEdit}
                        onChange={() => void choose({ provider: p.id })}
                      />
                      <ProviderLogo provider={p.id} size={22} />
                      <span className="flex-1 font-bold">{p.label}</span>
                      <span className={`chip ${ok ? 'chip-success' : ''}`}>
                        {ok ? 'Ready' : s[p.id].hasKey ? 'Pick a model' : 'No key'}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {!s.ready && (
              <p className="text-[14px] font-bold text-danger">
                {PROVIDER_INFO[s.provider].name} isn’t set up yet, so AI features are off. Add its
                key below, or switch to the other one.
              </p>
            )}
            <Select
              label="Effort"
              value={s.effort}
              disabled={!canEdit}
              onChange={(e) => void choose({ effort: e.target.value })}
            >
              {s.efforts.map((e) => (
                <option key={e} value={e}>
                  {e[0]?.toUpperCase()}
                  {e.slice(1)}: {EFFORT_HELP[e]}
                </option>
              ))}
            </Select>
            <FormError message={switchError} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {(['anthropic', 'openai'] as const).map((p) => (
              <ProviderCard
                key={p}
                provider={p}
                settings={s}
                canEdit={canEdit}
                onSaved={settings.setData}
              />
            ))}
          </div>
          {!canEdit && (
            <p className="text-[13px] text-muted">Owners and admins can change these.</p>
          )}
        </>
      )}

      {usage.data && (
        <div className="grid gap-3">
          <h3 className="font-bold">
            This month: about {dollars(total)}
            <span className="ml-2 text-[13px] font-normal text-muted">
              estimated from list prices
              {unknown.length > 0 && ` (not counting ${unknown.map((m) => m.label).join(', ')})`}
              {'; '}
              your provider’s console has the exact bill
            </span>
          </h3>
          {usage.data.models.length > 0 && (
            <div className="overflow-x-auto border-2 border-edge bg-surface">
              <table className="w-full min-w-[480px] text-left text-[14px]">
                <thead className="bg-surface-2 text-label uppercase text-muted">
                  <tr>
                    <th className="px-4 py-2">Model</th>
                    <th className="px-4 py-2">Requests</th>
                    <th className="px-4 py-2">Tokens in / cached / out</th>
                    <th className="px-4 py-2">Estimate</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-line">
                  {usage.data.models.map((m) => (
                    <tr key={m.model}>
                      <td className="px-4 py-2 font-bold">{m.label}</td>
                      <td className="px-4 py-2 tabular-nums">{m.requests}</td>
                      <td className="px-4 py-2 tabular-nums">
                        {thousands(m.input + m.cacheWrite)} / {thousands(m.cacheRead)} /{' '}
                        {thousands(m.output)}
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        {m.estimatedCost === null ? '—' : dollars(m.estimatedCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {usage.data.actions.length > 0 && (
            <details className="border-2 border-line px-4 py-2">
              <summary className="cursor-pointer text-[14px] font-bold">
                What the assistant did lately
              </summary>
              <ul className="mt-2 grid gap-1 text-[13px]">
                {usage.data.actions.map((a, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a read-only log, never reordered
                  <li key={i} className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted">{timeAgo(a.at)}</span>
                    <span className={a.ok ? '' : 'text-danger'}>
                      {a.decision === 'declined'
                        ? `Declined: ${a.tool.replace(/_/g, ' ')}`
                        : a.summary}
                      {a.decision === 'approved' && <span className="text-muted"> (approved)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

/** One provider's key and model. */
function ProviderCard({
  provider,
  settings,
  canEdit,
  onSaved,
}: {
  provider: AiProvider;
  settings: AiSettings;
  canEdit: boolean;
  onSaved: (s: AiSettings) => void;
}) {
  const info = PROVIDER_INFO[provider];
  const mine = settings[provider];
  const inUse = settings.provider === provider;
  // The list comes live from the provider, with the saved key; a new key fetches it again.
  const models = useApi<AiModelList>(
    mine.hasKey && canEdit
      ? `/settings/ai/models?provider=${provider}&key=${encodeURIComponent(mine.keyHint ?? '')}`
      : null,
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const listed = models.data?.models ?? [];
  const current = mine.model ?? models.data?.suggested ?? '';
  const options =
    current && !listed.some((m) => m.id === current)
      ? [{ id: current, label: current, created: '', note: undefined }, ...listed]
      : listed;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const apiKey = String(form.get('apiKey') ?? '').trim();
    const model = String(form.get('model') ?? '');
    setBusy(true);
    setMessage(undefined);
    try {
      onSaved(
        await api<AiSettings>(
          '/settings/ai',
          { [provider]: { ...(apiKey && { apiKey }), ...(model && { model }) } },
          'PUT',
        ),
      );
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err, 'Couldn’t save.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={save}
      className={`card card-flat grid content-start gap-3 ${inUse ? '' : 'opacity-90'}`}
      autoComplete="off"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-bold">
          <ProviderLogo provider={provider} size={22} />
          {info.name}
        </h3>
        {inUse && <span className="chip chip-orange">In use</span>}
      </div>
      <SecretField
        label="API key"
        name="apiKey"
        saved={mine.hasKey}
        savedHint={mine.keyHint}
        placeholder={info.keyPlaceholder}
        disabled={!canEdit}
        hint={mine.hasKey ? 'Saved and encrypted.' : `Create one at ${info.console} (API keys).`}
        reveal={async () =>
          (await api<{ value: string }>('/settings/ai/reveal', { provider })).value
        }
      />
      {mine.hasKey ? (
        <Select
          // Re-mounts once the live list arrives, so the saved model shows as selected.
          key={`${listed.length}:${current}`}
          label="Model"
          name="model"
          defaultValue={current}
          disabled={!canEdit || models.loading}
          hint={
            models.error
              ? errorText(models.error, 'Couldn’t load the models.')
              : models.loading
                ? `Loading ${info.name}’s models…`
                : `Live from ${info.name}, newest first.`
          }
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.label !== m.id ? ` (${m.id})` : ''}
              {m.note ? ` · ${m.note}` : ''}
            </option>
          ))}
        </Select>
      ) : (
        <p className="text-[13px] text-muted">
          Save a key to choose from {info.name}’s current models. Get one at{' '}
          <a href={info.consoleUrl} target="_blank" rel="noopener noreferrer">
            {info.console}
          </a>
          .
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
          {mine.hasKey && (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                setMessage(undefined);
                try {
                  const r = await api<{ model: string }>('/settings/ai/test', { provider });
                  setMessage({ ok: true, text: `The key works with ${r.model}.` });
                } catch (err) {
                  setMessage({ ok: false, text: errorText(err, 'The test didn’t go through.') });
                }
              }}
            >
              Test the key
            </button>
          )}
          {mine.hasKey && (
            <button
              type="button"
              className="linkbtn text-danger"
              onClick={async () => {
                if (
                  !confirm(
                    `Remove the ${info.name} key?${inUse ? ' AI features stop until you add one or switch providers.' : ''}`,
                  )
                )
                  return;
                onSaved(
                  await api<AiSettings>('/settings/ai', { [provider]: { apiKey: null } }, 'PUT'),
                );
              }}
            >
              Remove key
            </button>
          )}
        </div>
      )}
      {message &&
        (message.ok ? (
          <p className="text-[14px] font-bold text-success">{message.text}</p>
        ) : (
          <FormError message={message.text} />
        ))}
    </form>
  );
}
