import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useLocation } from 'react-router';
import {
  type AiSettings,
  ApiError,
  type AssistantItem,
  type AssistantThread,
  api,
  type Me,
  useApi,
} from '../api';
import { FormError } from '../ui';

// The in-app assistant: a panel beside any page. It reads on its own; anything it would change
// shows up as a card to approve or decline. A turn runs on the server; the panel checks back.

const SUGGESTIONS = [
  'Is my Instagram setup complete?',
  'Why didn’t my last commenter get a DM?',
  'Build a flow: when someone comments GUIDE, DM them my guide and ask for their email.',
];

export function AssistantPanel({ me, onClose }: { me: Me; onClose: () => void }) {
  const settings = useApi<AiSettings>('/settings/ai');
  const location = useLocation();
  const [thread, setThread] = useState<AssistantThread>();
  const [history, setHistory] = useState<{ id: string; title: string }[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const end = useRef<HTMLDivElement>(null);
  const role = me.workspaces[0]?.role;

  const loadThreads = useCallback(async () => {
    const r = await api<{ threads: { id: string; title: string }[] }>('/assistant/threads');
    setHistory(r.threads);
    return r.threads;
  }, []);

  // Open on the latest conversation.
  useEffect(() => {
    void loadThreads().then(async (threads) => {
      if (threads[0]) setThread(await api<AssistantThread>(`/assistant/threads/${threads[0].id}`));
    });
  }, [loadThreads]);

  // While a turn runs, check back.
  const working = thread?.status === 'working';
  useEffect(() => {
    if (!working || !thread) return;
    const t = setInterval(async () => {
      setThread(await api<AssistantThread>(`/assistant/threads/${thread.id}`));
    }, 1200);
    return () => clearInterval(t);
  }, [working, thread]);

  // Keep the latest message (or "Working on it…") in view.
  const scrollKey = `${thread?.items.length ?? 0}:${thread?.status ?? ''}`;
  useEffect(() => {
    if (scrollKey) end.current?.scrollIntoView({ block: 'end' });
  }, [scrollKey]);

  async function send(message: string) {
    if (!message.trim() || working || thread?.status === 'waiting') return;
    setError(undefined);
    try {
      const current = thread ?? (await api<AssistantThread>('/assistant/threads', {}));
      setThread(
        await api<AssistantThread>(`/assistant/threads/${current.id}/messages`, {
          text: message,
          page: location.pathname,
        }),
      );
      setText('');
      void loadThreads();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code.includes(' ') ? err.code : 'Couldn’t send that.',
      );
    }
  }

  async function decide(approve: boolean) {
    if (!thread) return;
    const waiting = thread.items.filter(
      (i): i is Extract<AssistantItem, { type: 'tool' }> =>
        i.type === 'tool' && i.state === 'waiting',
    );
    setThread(
      await api<AssistantThread>(`/assistant/threads/${thread.id}/decide`, {
        approve: approve ? waiting.filter((w) => !skipped.has(w.id)).map((w) => w.id) : [],
      }),
    );
    setSkipped(new Set());
  }

  const waitingCount =
    thread?.items.filter((i) => i.type === 'tool' && i.state === 'waiting').length ?? 0;

  return (
    <aside
      aria-label="Assistant"
      className="fixed inset-0 z-50 flex flex-col border-edge bg-surface shadow-hard-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[440px] sm:border-l-2"
    >
      <header className="flex items-center gap-2 border-b-2 border-edge px-4 py-3">
        <h2 className="flex-1 font-display text-display-sm font-bold">✨ Assistant</h2>
        {history.length > 0 && (
          <select
            className="input w-36 py-1 text-[13px]"
            aria-label="Earlier conversations"
            value={thread?.id ?? ''}
            onChange={async (e) =>
              setThread(await api<AssistantThread>(`/assistant/threads/${e.target.value}`))
            }
          >
            {!thread && <option value="">New chat</option>}
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title || 'New chat'}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="btn btn-sm"
          disabled={working}
          onClick={() => {
            setThread(undefined);
            setError(undefined);
          }}
        >
          New chat
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onClose}
          aria-label="Close the assistant"
        >
          ✕
        </button>
      </header>

      {settings.data && !settings.data.hasKey ? (
        <div className="grid gap-3 p-5 text-[15px]">
          <p>
            The assistant runs on Claude with your own Anthropic API key, and none is saved yet.
          </p>
          {role === 'agent' ? (
            <p className="text-muted">Ask an owner or admin to add one in Settings → AI.</p>
          ) : (
            <Link to="/settings#ai-h" className="btn btn-primary w-fit" onClick={onClose}>
              Add a key in Settings
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="grid gap-3">
              {!thread?.items.length && (
                <div className="grid gap-2">
                  <p className="text-[15px] text-muted">
                    Ask about your setup, a contact, or have it build a flow. It reads what it needs
                    and asks before changing anything.
                  </p>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="border-2 border-line px-3 py-2 text-left text-[14px] hover:border-edge"
                      onClick={() => void send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {thread?.items.map((item, i) =>
                item.type === 'user' ? (
                  <p
                    // biome-ignore lint/suspicious/noArrayIndexKey: the conversation only grows
                    key={i}
                    className="max-w-[90%] justify-self-end whitespace-pre-wrap border-2 border-edge bg-surface-2 px-3 py-2 text-[15px]"
                  >
                    {item.text}
                  </p>
                ) : item.type === 'assistant' ? (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: the conversation only grows
                    key={i}
                    className="grid gap-2 text-[15px] [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
                  >
                    <Markdown>{item.text}</Markdown>
                  </div>
                ) : item.changes ? (
                  <ChangeCard
                    key={item.id}
                    item={item}
                    skipped={skipped.has(item.id)}
                    onToggle={
                      waitingCount > 1
                        ? () =>
                            setSkipped((s) => {
                              const next = new Set(s);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })
                        : undefined
                    }
                  />
                ) : (
                  <p key={item.id} className="text-[13px] text-muted">
                    {item.state === 'failed' ? '✕' : item.state === 'running' ? '…' : '✓'}{' '}
                    {item.label}
                    {item.detail[0] ? ` ${item.detail[0]}` : ''}
                    {item.error && <span className="block text-danger">{item.error}</span>}
                  </p>
                ),
              )}
              {working && <p className="text-[14px] text-muted">Working on it…</p>}
              {thread?.status === 'error' && thread.error && <FormError message={thread.error} />}
              <div ref={end} />
            </div>
          </div>

          {thread?.status === 'waiting' ? (
            <div className="grid gap-2 border-t-2 border-edge bg-surface-2 px-4 py-3">
              <p className="text-[14px] font-bold">
                {waitingCount > 1 ? 'Apply these changes?' : 'Apply this change?'}
              </p>
              <div className="flex gap-2">
                <button type="button" className="btn btn-primary" onClick={() => void decide(true)}>
                  {waitingCount > 1 ? 'Approve checked' : 'Approve'}
                </button>
                <button type="button" className="btn" onClick={() => void decide(false)}>
                  Decline
                </button>
              </div>
            </div>
          ) : (
            <form
              className="grid gap-2 border-t-2 border-edge px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  className="input min-h-[44px] flex-1 resize-y"
                  rows={2}
                  aria-label="Ask the assistant"
                  placeholder="Ask anything… (Enter sends)"
                  value={text}
                  disabled={working}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send(text);
                    }
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={working || !text.trim()}
                >
                  Send
                </button>
              </div>
              <FormError message={error} />
            </form>
          )}
        </>
      )}
    </aside>
  );
}

/** A change the assistant wants to make, with what it contains. */
function ChangeCard({
  item,
  skipped,
  onToggle,
}: {
  item: Extract<AssistantItem, { type: 'tool' }>;
  skipped: boolean;
  onToggle?: () => void;
}) {
  const status = {
    waiting: <span className="chip chip-orange">Needs your OK</span>,
    running: <span className="chip">Applying…</span>,
    done: <span className="chip chip-success">Done</span>,
    failed: <span className="chip chip-danger">Didn’t work</span>,
    declined: <span className="chip">Declined</span>,
  }[item.state];
  return (
    <div
      className={`grid gap-2 border-2 px-3 py-2 ${item.state === 'waiting' ? 'border-accent' : 'border-line'} ${skipped ? 'opacity-50' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {onToggle && item.state === 'waiting' && (
          <input
            type="checkbox"
            checked={!skipped}
            onChange={onToggle}
            aria-label={`Include: ${item.label}`}
          />
        )}
        <p className="flex-1 font-bold">{item.label}</p>
        {status}
      </div>
      {item.detail.length > 0 && (
        <ol className="grid gap-0.5 text-[13px] text-muted">
          {item.detail.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps in order, never reordered
            <li key={i}>{d}</li>
          ))}
        </ol>
      )}
      {item.error && <p className="text-[13px] text-danger">{item.error}</p>}
    </div>
  );
}
