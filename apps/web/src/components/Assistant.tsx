import {
  ArrowRight,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  ClockCounterClockwise,
  NotePencil,
  PaperPlaneRight,
  Sparkle,
  X,
  XCircle,
} from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  type AiSettings,
  ApiError,
  type AssistantItem,
  type AssistantThread,
  api,
  FLOW_CHANGED,
  type Me,
  useApi,
} from '../api';
import { FormError } from '../ui';

// The in-app assistant: a panel beside any page. It reads on its own, opens the page it's talking
// about, asks one question at a time on cards, and shows anything it would change as a card to
// approve. A turn runs on the server; the panel checks back.

type ToolItem = Extract<AssistantItem, { type: 'tool' }>;
type AskItem = Extract<AssistantItem, { type: 'ask' }>;

const SUGGESTIONS = [
  'Build a flow with me: when someone comments GUIDE, DM them my guide and ask for their email.',
  'Is my Instagram setup complete?',
  'Why didn’t my last commenter get a DM?',
];

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError && err.code.includes(' ') ? err.code : fallback;

export function AssistantPanel({ me, onClose }: { me: Me; onClose: () => void }) {
  const settings = useApi<AiSettings>('/settings/ai');
  const location = useLocation();
  const navigate = useNavigate();
  const [thread, setThread] = useState<AssistantThread>();
  const [history, setHistory] = useState<{ id: string; title: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  /** Pages opened and flows changed that the panel has already acted on, per conversation. */
  const acted = useRef<{ thread: string; ids: Set<string> }>(undefined);
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

  // Follow along: open the pages it opens, and reload a flow it changed if the builder shows it.
  // What happened before this conversation was on screen is only remembered, not replayed.
  useEffect(() => {
    if (!thread) return;
    const done = thread.items.filter(
      (i): i is ToolItem =>
        i.type === 'tool' && i.state === 'done' && Boolean(i.navigate || (i.changes && i.flowId)),
    );
    if (acted.current?.thread !== thread.id) {
      acted.current = { thread: thread.id, ids: new Set(done.map((i) => i.id)) };
      return;
    }
    for (const i of done) {
      if (acted.current.ids.has(i.id)) continue;
      acted.current.ids.add(i.id);
      if (i.changes && i.flowId)
        window.dispatchEvent(new CustomEvent(FLOW_CHANGED, { detail: { flowId: i.flowId } }));
      if (i.navigate && i.navigate !== location.pathname) navigate(i.navigate);
    }
  }, [thread, navigate, location.pathname]);

  // Keep the latest message (or the "thinking" line) in view.
  const scrollKey = `${thread?.items.length ?? 0}:${thread?.status ?? ''}`;
  useEffect(() => {
    if (scrollKey) end.current?.scrollIntoView({ block: 'end' });
  }, [scrollKey]);

  // The message box grows with what's typed, up to a point.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const waitingTools = thread?.items.filter(
    (i): i is ToolItem => i.type === 'tool' && i.state === 'waiting',
  );
  const waitingAsk = thread?.items.find(
    (i): i is AskItem => i.type === 'ask' && i.state === 'waiting',
  );
  const waitingCount = waitingTools?.length ?? 0;
  const busy = working || sending;

  async function send(message: string) {
    if (!message.trim() || busy || (thread?.status === 'waiting' && !waitingAsk)) return;
    setError(undefined);
    setSending(true);
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
      setError(errorText(err, 'Couldn’t send that.'));
    } finally {
      setSending(false);
    }
  }

  async function decide(body: { approve: string[]; answers?: Record<string, string> }) {
    if (!thread) return;
    setError(undefined);
    setSending(true);
    try {
      setThread(await api<AssistantThread>(`/assistant/threads/${thread.id}/decide`, body));
      setSkipped(new Set());
    } catch (err) {
      setError(errorText(err, 'Couldn’t send that.'));
    } finally {
      setSending(false);
    }
  }

  const ready = settings.data?.ready;

  return (
    <aside
      aria-label="Assistant"
      className="fixed inset-0 z-50 flex flex-col bg-surface shadow-hard-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[460px] sm:border-l-2 sm:border-edge"
    >
      <header className="flex items-center gap-1 border-b-2 border-edge py-2 pr-2 pl-4">
        <Sparkle size={20} weight="fill" className="shrink-0 text-primary" aria-hidden />
        <div className="ml-1 min-w-0 flex-1">
          <h2 className="text-[16px] leading-tight font-bold">Assistant</h2>
          {thread?.title && (
            <p className="truncate text-[12px] leading-tight text-muted">{thread.title}</p>
          )}
        </div>
        {history.length > 0 && (
          <IconButton
            label="Earlier conversations"
            pressed={showHistory}
            onClick={() => setShowHistory((on) => !on)}
          >
            <ClockCounterClockwise size={20} />
          </IconButton>
        )}
        <IconButton
          label="New conversation"
          disabled={busy}
          onClick={() => {
            setThread(undefined);
            setError(undefined);
            setShowHistory(false);
            box.current?.focus();
          }}
        >
          <NotePencil size={20} />
        </IconButton>
        <IconButton label="Close the assistant" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </header>

      {showHistory && (
        <nav
          aria-label="Earlier conversations"
          className="max-h-72 overflow-y-auto border-b-2 border-edge bg-surface-2 py-1"
        >
          {history.map((h) => (
            <button
              key={h.id}
              type="button"
              className={`block w-full truncate px-4 py-2 text-left text-[14px] hover:bg-surface ${h.id === thread?.id ? 'font-bold' : ''}`}
              onClick={async () => {
                setShowHistory(false);
                setThread(await api<AssistantThread>(`/assistant/threads/${h.id}`));
              }}
            >
              {h.title || 'New conversation'}
            </button>
          ))}
        </nav>
      )}

      {settings.data && !ready ? (
        <div className="grid content-start gap-3 p-5 text-[15px]">
          <p>
            AI isn’t set up yet. The assistant runs on your own API key from Anthropic (Claude) or
            OpenAI.
          </p>
          {role === 'agent' ? (
            <p className="text-muted">Ask an owner or admin to add one in Settings → AI.</p>
          ) : (
            <Link to="/settings/ai" className="btn btn-primary w-fit" onClick={onClose}>
              Set up AI in Settings
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 [overflow-wrap:anywhere]">
              {!thread?.items.length && (
                <div className="grid gap-3">
                  <p className="text-[15px]">
                    I can build flows with you step by step, check your setup, or find out why
                    someone didn’t get a reply. I’ll show you the page I’m talking about, and I
                    always ask before changing anything.
                  </p>
                  <div className="grid gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="flex items-start gap-2 border-2 border-line px-3 py-2.5 text-left text-[14px] hover:border-edge"
                        onClick={() => void send(s)}
                      >
                        <ArrowRight size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {thread && (
                <Conversation
                  items={thread.items}
                  skipped={skipped}
                  waitingCount={waitingCount}
                  busy={busy}
                  onToggle={(id) =>
                    setSkipped((s) => {
                      const next = new Set(s);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onAnswer={(item, answer) =>
                    decide({ approve: [], answers: { [item.id]: answer } })
                  }
                />
              )}
              {working && <Thinking items={thread?.items ?? []} />}
              {thread?.status === 'error' && thread.error && <FormError message={thread.error} />}
              <div ref={end} />
            </div>
          </div>

          {thread?.status === 'waiting' && waitingCount > 0 ? (
            <div className="grid gap-2 border-t-2 border-edge bg-surface-2 px-4 py-3">
              <p className="text-[14px] font-bold">
                {waitingCount > 1 ? 'Apply the checked changes?' : 'Apply this change?'}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void decide({
                      approve: (waitingTools ?? [])
                        .filter((w) => !skipped.has(w.id))
                        .map((w) => w.id),
                    })
                  }
                >
                  {waitingCount > 1 ? 'Approve checked' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void decide({ approve: [] })}
                >
                  Decline
                </button>
              </div>
              <FormError message={error} />
            </div>
          ) : (
            <form
              className="grid gap-2 border-t-2 border-edge px-3 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={box}
                  className="input max-h-40 min-h-[46px] flex-1 resize-none py-2.5 leading-snug"
                  rows={1}
                  aria-label={waitingAsk ? 'Your answer' : 'Ask the assistant'}
                  placeholder={
                    waitingAsk ? 'Type your answer… (Enter sends)' : 'Ask anything… (Enter sends)'
                  }
                  value={text}
                  disabled={busy}
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
                  className="btn btn-primary grid h-[46px] w-[46px] shrink-0 place-items-center p-0"
                  aria-label="Send"
                  disabled={busy || !text.trim()}
                >
                  <PaperPlaneRight size={20} weight="fill" aria-hidden />
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

function IconButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-10 w-10 place-items-center border-2 hover:border-edge disabled:opacity-40 ${pressed ? 'border-edge bg-surface-2' : 'border-transparent'}`}
    >
      {children}
    </button>
  );
}

/** The conversation: messages, a compact line for what it looked at, questions and changes. */
function Conversation({
  items,
  skipped,
  waitingCount,
  busy,
  onToggle,
  onAnswer,
}: {
  items: AssistantItem[];
  skipped: Set<string>;
  waitingCount: number;
  busy: boolean;
  onToggle: (id: string) => void;
  onAnswer: (item: AskItem, answer: string) => Promise<void>;
}) {
  // Reading steps in a row collapse into one activity line.
  const rows: (AssistantItem | ToolItem[])[] = [];
  for (const item of items) {
    const quiet = item.type === 'tool' && !item.changes;
    const last = rows.at(-1);
    if (quiet && Array.isArray(last)) last.push(item);
    else rows.push(quiet ? [item] : item);
  }
  return (
    <>
      {rows.map((row, i) => {
        if (Array.isArray(row))
          // biome-ignore lint/suspicious/noArrayIndexKey: the conversation only grows
          return <Activity key={i} items={row} />;
        if (row.type === 'user')
          return (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: the conversation only grows
              key={i}
              className="max-w-[88%] justify-self-end border-2 border-edge bg-surface-2 px-3 py-2 text-[15px] whitespace-pre-wrap"
            >
              {row.text}
            </p>
          );
        if (row.type === 'assistant')
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: the conversation only grows
              key={i}
              className="grid gap-2.5 text-[15px] leading-relaxed [&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:bg-surface-2 [&_code]:px-1 [&_li]:ml-5 [&_li+li]:mt-1 [&_ol]:list-decimal [&_ul]:list-disc"
            >
              <Markdown>{row.text}</Markdown>
            </div>
          );
        if (row.type === 'ask')
          return <AskCard key={row.id} item={row} busy={busy} onAnswer={onAnswer} />;
        return (
          <ChangeCard
            key={row.id}
            item={row}
            skipped={skipped.has(row.id)}
            onToggle={waitingCount > 1 ? () => onToggle(row.id) : undefined}
          />
        );
      })}
    </>
  );
}

/** What it looked at and opened, on one quiet line. */
function Activity({ items }: { items: ToolItem[] }) {
  const navigate = useNavigate();
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted">
      {items.map((item) => (
        <li
          key={item.id}
          className={`flex items-center gap-1 ${item.state === 'failed' ? 'text-danger' : ''}`}
          title={item.error}
        >
          {item.state === 'failed' ? (
            <XCircle size={15} className="text-danger" aria-label="Didn’t work" />
          ) : item.state === 'running' ? (
            <CircleNotch size={15} className="animate-spin" aria-label="Working" />
          ) : (
            <CheckCircle size={15} aria-hidden />
          )}
          {item.navigate ? (
            <button
              type="button"
              className="flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-ink"
              onClick={() => item.navigate && navigate(item.navigate)}
            >
              {item.label}
              <ArrowSquareOut size={13} aria-hidden />
            </button>
          ) : (
            <span>
              {item.label}
              {item.detail[0] ? ` ${item.detail[0]}` : ''}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The "thinking" line, naming what it's doing when it can. */
function Thinking({ items }: { items: AssistantItem[] }) {
  const running = items.findLast((i): i is ToolItem => i.type === 'tool' && i.state === 'running');
  return (
    <p className="flex items-center gap-2 text-[14px] text-muted" aria-live="polite">
      <span className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="h-1.5 w-1.5 animate-bounce bg-muted"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
      {running ? `${running.label}…` : 'Thinking…'}
    </p>
  );
}

/** A question to fill in or a choice to tap; once answered, a short record of it. */
function AskCard({
  item,
  busy,
  onAnswer,
}: {
  item: AskItem;
  busy: boolean;
  onAnswer: (item: AskItem, answer: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  if (item.state !== 'waiting')
    return (
      <div className="grid gap-0.5 border-l-4 border-line pl-3 text-[14px]">
        <p className="text-muted">{item.question}</p>
        <p className={item.state === 'answered' ? 'font-bold whitespace-pre-wrap' : 'text-muted'}>
          {item.state === 'answered' ? item.answer : 'Skipped'}
        </p>
      </div>
    );
  const choice = item.kind === 'choice' && item.options.length > 0;
  const inputMode = (
    { url: 'url', email: 'email', number: 'decimal' } as Record<string, 'url' | 'email' | 'decimal'>
  )[item.kind];
  const submit = () => {
    if (value.trim()) void onAnswer(item, value.trim());
  };
  const step = item.step && item.steps ? Math.min(item.step, item.steps) : undefined;
  return (
    <div className="grid gap-3 border-2 border-primary bg-surface p-3 shadow-hard">
      {step && item.steps && item.steps > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-label whitespace-nowrap text-muted uppercase">
            Step {step} of {item.steps}
          </span>
          <span className="h-1.5 flex-1 bg-line" aria-hidden>
            <span
              className="block h-full bg-primary"
              style={{ width: `${(step / item.steps) * 100}%` }}
            />
          </span>
        </div>
      )}
      {item.overview && item.overview.length > 1 && (
        <ol className="grid gap-1 border-b-2 border-line pb-3 text-[13px]">
          {item.overview.map((o, i) => {
            const n = i + 1;
            const state = !step ? 'next' : n < step ? 'done' : n === step ? 'now' : 'next';
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the plan's steps, in order
                key={i}
                className={`flex items-start gap-2 ${state === 'now' ? 'font-bold' : 'text-muted'}`}
                aria-current={state === 'now' ? 'step' : undefined}
              >
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center border-2 text-[11px] ${state === 'now' ? 'border-primary bg-primary text-on-primary' : 'border-line'}`}
                  aria-hidden
                >
                  {state === 'done' ? <CheckCircle size={12} weight="bold" /> : n}
                </span>
                <span className={state === 'done' ? 'line-through decoration-1' : ''}>{o}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="grid gap-1">
        <p className="text-[16px] font-bold">{item.question}</p>
        {item.help && <p className="text-[14px] text-muted">{item.help}</p>}
      </div>
      {choice && (
        <div className="flex flex-wrap gap-2">
          {item.options.map((o) => (
            <button
              key={o}
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void onAnswer(item, o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {item.kind === 'long_text' ? (
          <textarea
            className="input min-h-[88px] flex-1"
            aria-label={item.question}
            placeholder={item.placeholder}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            className="input min-w-0 flex-1"
            aria-label={item.question}
            inputMode={inputMode}
            placeholder={item.placeholder ?? (choice ? 'Or type your own…' : '')}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
          Answer
        </button>
      </form>
      <button
        type="button"
        className="linkbtn w-fit text-[13px] text-muted"
        disabled={busy}
        onClick={() => void onAnswer(item, '')}
      >
        Skip this question
      </button>
    </div>
  );
}

/** A change the assistant wants to make, with what it contains. */
function ChangeCard({
  item,
  skipped,
  onToggle,
}: {
  item: ToolItem;
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
      className={`grid gap-2 border-2 bg-surface px-3 py-2.5 ${item.state === 'waiting' ? 'border-primary shadow-hard' : 'border-line'} ${skipped ? 'opacity-50' : ''}`}
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
        <ol className="grid gap-1 border-t-2 border-line pt-2 text-[13px] text-muted">
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
