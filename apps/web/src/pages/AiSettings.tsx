import { type FormEvent, useState } from 'react';
import { type AiSettings, type AiUsage, ApiError, api, type Me, useApi } from '../api';
import { Field, FormError, Select, timeAgo } from '../ui';

// Settings → AI: bring your own Anthropic key, pick the model, see what it has used and done.

const EFFORT_HELP: Record<string, string> = {
  low: 'Quick answers, fewest tokens.',
  medium: 'Balanced (the default).',
  high: 'Thinks harder; best for building bigger flows. Uses more tokens.',
};

const dollars = (n: number) => (n < 0.01 ? (n > 0 ? '< $0.01' : '$0.00') : `$${n.toFixed(2)}`);
const thousands = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

export function AiSection({ me }: { me: Me }) {
  const settings = useApi<AiSettings>('/settings/ai');
  const usage = useApi<AiUsage>('/settings/ai/usage');
  const role = me.workspaces[0]?.role;
  const canEdit = role === 'owner' || role === 'admin';
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const apiKey = String(form.get('apiKey') ?? '').trim();
    setBusy(true);
    setMessage(undefined);
    try {
      settings.setData(
        await api<AiSettings>(
          '/settings/ai',
          { model: form.get('model'), effort: form.get('effort'), ...(apiKey && { apiKey }) },
          'PUT',
        ),
      );
      (e.target as HTMLFormElement).reset();
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({
        ok: false,
        text:
          err instanceof ApiError
            ? (Object.values(err.fieldErrors())[0] ?? 'Couldn’t save.')
            : 'Couldn’t save.',
      });
    } finally {
      setBusy(false);
    }
  }

  const s = settings.data;
  const total = usage.data?.models.reduce((sum, m) => sum + m.estimatedCost, 0) ?? 0;

  return (
    <section aria-labelledby="ai-h" className="grid gap-4">
      <div>
        <h2 id="ai-h" className="font-display text-display-sm font-bold">
          AI
        </h2>
        <p className="mt-1 text-[15px] text-muted">
          The assistant (✨ in the menu) answers questions about your setup, explains why someone
          didn’t get a reply, and builds flows, asking before it changes anything. It runs on Claude
          with your own Anthropic API key: Anthropic bills that key directly, nothing goes through
          anyone else. Get a key at{' '}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
          >
            console.anthropic.com
          </a>
          .
        </p>
      </div>

      {s && (
        <form onSubmit={save} className="card card-flat grid gap-3" autoComplete="off">
          <Field
            label="Anthropic API key"
            name="apiKey"
            type="password"
            placeholder={s.hasKey ? 'Saved, encrypted. Paste a new one to replace it.' : 'sk-ant-…'}
            disabled={!canEdit}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Model" name="model" defaultValue={s.model} disabled={!canEdit}>
              {s.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · ${m.input} / ${m.output} per million tokens
                </option>
              ))}
            </Select>
            <Select label="Effort" name="effort" defaultValue={s.effort} disabled={!canEdit}>
              {s.efforts.map((e) => (
                <option key={e} value={e}>
                  {e[0]?.toUpperCase()}
                  {e.slice(1)}: {EFFORT_HELP[e]}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-[13px] text-muted">
            {s.models.map((m) => `${m.label}: ${m.note}`).join(' ')}
          </p>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Save
              </button>
              {s.hasKey && (
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    setMessage(undefined);
                    try {
                      const r = await api<{ model: string }>('/settings/ai/test', {});
                      setMessage({ ok: true, text: `The key works with ${r.model}.` });
                    } catch (err) {
                      setMessage({
                        ok: false,
                        text: err instanceof ApiError ? err.code : 'The test didn’t go through.',
                      });
                    }
                  }}
                >
                  Test the key
                </button>
              )}
              {s.hasKey && (
                <button
                  type="button"
                  className="linkbtn text-danger"
                  onClick={async () => {
                    if (
                      !confirm('Remove the API key? The assistant stops working until you add one.')
                    )
                      return;
                    settings.setData(
                      await api<AiSettings>('/settings/ai', { apiKey: null }, 'PUT'),
                    );
                  }}
                >
                  Remove key
                </button>
              )}
            </div>
          )}
          {!canEdit && (
            <p className="text-[13px] text-muted">Owners and admins can change these.</p>
          )}
          {message &&
            (message.ok ? (
              <p className="text-[14px] font-bold text-success">{message.text}</p>
            ) : (
              <FormError message={message.text} />
            ))}
        </form>
      )}

      {usage.data && (
        <div className="grid gap-3">
          <h3 className="font-bold">
            This month: about {dollars(total)}
            <span className="ml-2 text-[13px] font-normal text-muted">
              estimated from list prices; your Anthropic console has the exact bill
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
                      <td className="px-4 py-2 tabular-nums">{dollars(m.estimatedCost)}</td>
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
