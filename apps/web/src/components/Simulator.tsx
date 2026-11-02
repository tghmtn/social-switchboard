import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type SimMessage, type SimRun, type SimState, useApi } from '../api';
import { FormError } from '../ui';

// A chat with your own automations, as a follower would see it. Every action goes through the same
// runtime Instagram will use; the server returns the whole new state after each one.

const RUN_LABEL: Record<SimRun['status'], string> = {
  waiting: 'Waiting',
  completed: 'Finished',
  failed: 'Failed',
  expired: 'Timed out',
  cancelled: 'Stopped',
};
const RUN_CHIP: Record<SimRun['status'], string> = {
  waiting: 'chip-orange',
  completed: 'chip-success',
  failed: 'chip-danger',
  expired: '',
  cancelled: '',
};

function waitText(r: SimRun) {
  if (r.status !== 'waiting') return r.error ?? '';
  const when = r.wakeAt
    ? new Date(r.wakeAt).toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';
  if (r.waitKind === 'delay') return `Delay until ${when}`;
  if (r.waitKind === 'choice') return 'Waiting for a tap or reply';
  if (r.waitKind === 'ai') return 'AI conversation: waiting for a reply';
  if (r.waitKind === 'route') return 'AI is sorting their message';
  return 'Waiting for an answer';
}

export function Simulator({ flowId, showState = true }: { flowId?: string; showState?: boolean }) {
  const { data, setData, reload } = useApi<SimState>('/simulator');
  const [text, setText] = useState('');
  const [asComment, setAsComment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);

  const act = useCallback(
    async (path: string, body: object = {}) => {
      setBusy(true);
      setError(undefined);
      try {
        setData(await api<SimState>(path, body));
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 409
            ? 'Publish this automation first, or test the draft.'
            : err instanceof ApiError && err.code === 'invalid_input'
              ? 'That didn’t go through. Check the message and try again.'
              : 'Something went wrong talking to the server.',
        );
      } finally {
        setBusy(false);
      }
    },
    [setData],
  );

  const messages = data?.messages ?? [];
  const runs = data?.runs ?? [];
  const waiting = runs.filter((r) => r.status === 'waiting');
  const lastOutIndex = messages.findLastIndex((m) => m.direction === 'out');
  const choiceOpen = waiting.some((r) => r.waitKind === 'choice');
  const follows = data?.contact?.followsUs ?? false;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever a message arrives
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // While a delay is pending, check back so the worker's follow-up shows up on its own.
  const delayPending = waiting.some((r) => r.waitKind === 'delay');
  useEffect(() => {
    if (!delayPending) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [delayPending, reload]);

  function send(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    void act(asComment ? '/simulator/comment' : '/simulator/send', { text: t });
  }

  return (
    <div className={`grid min-h-0 gap-4 ${showState ? 'lg:grid-cols-[minmax(0,1fr)_280px]' : ''}`}>
      <div className="card flex min-h-[420px] flex-col p-0">
        <div className="flex flex-wrap items-center gap-2 border-b-2 border-edge px-3 py-2.5">
          {flowId && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => act('/simulator/start', { flowId, version: 'draft' })}
            >
              Run this draft
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !waiting.some((r) => r.wakeAt)}
            onClick={() => act('/simulator/fast-forward')}
            title="Fire pending delays and reply timeouts now"
          >
            Skip waits
          </button>
          <button
            type="button"
            className={`btn btn-sm ${follows ? 'bg-surface-2 shadow-hard-sm' : ''}`}
            aria-pressed={follows}
            disabled={busy}
            onClick={() => act('/simulator/follows', { follows: !follows })}
            title="Whether this test contact follows you, for “follows you” checks"
          >
            Follows you: {follows ? 'yes' : 'no'}
          </button>
          <button
            type="button"
            className="btn btn-sm ml-auto"
            disabled={busy || !data?.contact}
            onClick={() => act('/simulator/reset')}
            title="Forget this test contact: messages, tags, fields and runs"
          >
            Reset
          </button>
        </div>

        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-bg px-3 py-4"
          aria-live="polite"
        >
          {messages.length === 0 && (
            <p className="m-auto max-w-xs text-center text-[15px] text-muted">
              {flowId
                ? 'Run this draft, or send a keyword like a follower would.'
                : 'Send a keyword like a follower would.'}{' '}
              Published automations answer here exactly as they will on Instagram.
            </p>
          )}
          {messages.map((m, i) => (
            <Bubble
              key={m.id}
              m={m}
              interactive={i === lastOutIndex && choiceOpen}
              busy={busy}
              onTap={(payload, label) => act('/simulator/tap', { payload, label })}
            />
          ))}
          {data?.contact?.automationPausedAt && (
            <div className="border-2 border-accent bg-surface px-3 py-2 text-sm">
              <b>Handed off to a person.</b> Automation is paused for this contact.{' '}
              <button type="button" className="linkbtn" onClick={() => act('/simulator/resume')}>
                Resume automation
              </button>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <form onSubmit={send} className="flex gap-2 border-t-2 border-edge p-2.5">
          <button
            type="button"
            className={`btn btn-sm shrink-0 ${asComment ? 'bg-surface-2 shadow-hard-sm' : ''}`}
            aria-pressed={asComment}
            onClick={() => setAsComment((c) => !c)}
            title="Send as a public comment on a post, to test comment triggers"
          >
            {asComment ? '💬 Comment' : 'DM'}
          </button>
          <label htmlFor="sim-input" className="sr-only">
            {asComment ? 'Comment' : 'Message'}
          </label>
          <input
            id="sim-input"
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={asComment ? 'Comment on a post…' : 'Type a message…'}
            autoComplete="off"
            maxLength={2000}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
        {error && (
          <div className="px-3 pb-3">
            <FormError message={error} />
          </div>
        )}
      </div>

      {showState && (
        <aside className="grid content-start gap-4" aria-label="Test contact">
          <div className="card grid gap-3">
            <h3 className="text-lg font-bold">Test contact</h3>
            <div>
              <p className="text-label uppercase text-muted">Tags</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {data?.contact?.tags.length ? (
                  data.contact.tags.map((t) => (
                    <span key={t} className="chip chip-lime">
                      {t}
                    </span>
                  ))
                ) : (
                  <span className="text-[13px] text-muted">None yet</span>
                )}
              </div>
            </div>
            <div>
              <p className="text-label uppercase text-muted">Fields</p>
              <dl className="mt-1.5 grid gap-1 text-[14px]">
                {Object.entries(data?.contact?.fields ?? {})
                  .filter(([, v]) => v !== null && v !== '')
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-muted">{k}</dt>
                      <dd className="truncate font-bold">{String(v)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </div>
          <div className="card grid gap-2">
            <h3 className="text-lg font-bold">Runs</h3>
            {runs.length === 0 && <p className="text-[13px] text-muted">Nothing has run yet.</p>}
            {runs.map((r) => (
              <div
                key={r.id}
                className="grid gap-1 border-t-2 border-line pt-2 first-of-type:border-0 first-of-type:pt-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-bold">
                    {r.flowName}
                    {r.test && <span className="font-normal text-muted"> · draft</span>}
                  </span>
                  <span className={`chip ${RUN_CHIP[r.status]}`}>{RUN_LABEL[r.status]}</span>
                </div>
                {waitText(r) && <span className="text-[13px] text-muted">{waitText(r)}</span>}
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

function Bubble({
  m,
  interactive,
  busy,
  onTap,
}: {
  m: SimMessage;
  interactive: boolean;
  busy: boolean;
  onTap: (payload: string, label: string) => void;
}) {
  if (m.content.kind === 'in') {
    const c = m.content;
    return (
      <div className="bubble bubble-me">
        {c.comment && (
          <span className="mb-1 block text-label uppercase text-muted">Public comment</span>
        )}
        {c.text ?? (c.ref ? `Opened a link (ref=${c.ref})` : 'Tapped a button')}
      </div>
    );
  }
  const { message, payloads, privateReplyTo, publicReplyTo } = m.content;
  return (
    <div className="grid max-w-[85%] gap-2">
      <div className={`bubble bubble-bot max-w-none ${publicReplyTo ? 'border-dashed' : ''}`}>
        {(privateReplyTo || publicReplyTo) && (
          <span className="mb-1 block text-label uppercase text-muted">
            {publicReplyTo ? 'Public reply under the comment' : 'Private reply to the comment'}
          </span>
        )}
        {message.parts.map((p, i) => {
          const key = `${m.id}-${i}`;
          if (p.type === 'text')
            return (
              <p key={key} className="whitespace-pre-wrap">
                {p.text}
              </p>
            );
          if (p.type === 'image')
            return <img key={key} className="ph mt-1 max-h-60" src={p.url} alt={p.alt ?? ''} />;
          return (
            <a
              key={key}
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold"
            >
              📄 {p.name}
            </a>
          );
        })}
        {message.buttons.length > 0 && (
          <div className="mt-2 grid gap-1.5">
            {message.buttons.map((b) =>
              b.kind === 'url' ? (
                <a
                  key={b.id}
                  href={b.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm w-full"
                  title={b.url}
                >
                  {b.label} ↗
                </a>
              ) : (
                <button
                  key={b.id}
                  type="button"
                  className="btn btn-sm w-full"
                  disabled={busy || !payloads[b.id]}
                  onClick={() => onTap(payloads[b.id] ?? '', b.label)}
                >
                  {b.label}
                </button>
              ),
            )}
          </div>
        )}
      </div>
      {interactive && message.quickReplies.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {message.quickReplies.map((q) => (
            <button
              key={q.id}
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => onTap(payloads[q.id] ?? '', q.label)}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      {(m.status === 'failed' || m.status === 'blocked') && (
        <span className="chip chip-danger w-fit">{m.error ?? m.status}</span>
      )}
    </div>
  );
}
