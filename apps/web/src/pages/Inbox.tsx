import { InstagramLogo } from '@phosphor-icons/react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ApiError,
  api,
  avatarUrl,
  type InboxDetail,
  type InboxList,
  type InboxMessageContent,
  type InboxView,
  useApi,
} from '../api';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, FormError, timeAgo } from '../ui';
import { contactName } from './Contacts';

// The inbox: the conversation list beside the open conversation (one at a time on a phone).
// Both check back every few seconds while the tab is visible.

const VIEWS: { id: InboxView; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'unread', label: 'Unread' },
  { id: 'mine', label: 'Mine' },
  { id: 'attention', label: 'Paused' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

/** Calls reload every `ms` while the page is visible. */
function usePolling(reload: () => unknown, ms: number) {
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
}

const clock = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

export function Inbox() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as InboxView | null) ?? 'open';
  const [search, setSearch] = useState('');
  const query = new URLSearchParams({ view, ...(search.trim() && { q: search.trim() }) });
  const list = useApi<InboxList>(`/inbox?${query}`);
  usePolling(list.reload, 5000);

  return (
    // Fills the screen below the phone nav (all of it beside the sidebar), so only the lists scroll
    // and the reply box stays in view.
    <div className="grid h-[calc(100dvh-9.25rem)] min-[900px]:h-dvh lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside
        className={`min-h-0 flex-col border-edge bg-surface lg:flex lg:border-r-2 ${id ? 'hidden' : 'flex'}`}
        aria-label="Conversations"
      >
        <div className="grid gap-3 border-b-2 border-edge px-4 py-4">
          <h1 className="font-display text-display-sm font-bold">Inbox</h1>
          <div className="flex flex-wrap gap-1" role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                onClick={() => setParams(v.id === 'open' ? {} : { view: v.id }, { replace: true })}
                className={`shrink-0 border-2 px-2.5 py-1 text-[13px] font-bold ${view === v.id ? 'border-edge bg-surface-2 shadow-hard-sm' : 'border-transparent hover:border-line'}`}
              >
                {v.label}
                {list.data && list.data.counts[v.id] > 0 && (
                  <span className="ml-1.5 text-muted tabular-nums">{list.data.counts[v.id]}</span>
                )}
              </button>
            ))}
          </div>
          <input
            className="input"
            type="search"
            placeholder="Search name or @username"
            aria-label="Search conversations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <ul className="min-h-0 flex-1 divide-y-2 divide-line overflow-y-auto">
          {list.data?.conversations.length === 0 && (
            <li className="px-4 py-8 text-center text-[14px] text-muted">
              {view === 'open' && !search
                ? 'No open conversations. Messages and comments on your channels show up here.'
                : 'Nothing here.'}
            </li>
          )}
          {list.data?.conversations.map((c) => {
            const name = contactName(c);
            const active = c.contactId === id;
            return (
              <li key={c.contactId}>
                <Link
                  to={`/inbox/${c.contactId}${view === 'open' ? '' : `?view=${view}`}`}
                  className={`flex gap-3 px-4 py-3 text-ink no-underline ${active ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                >
                  <Avatar name={name} size={40} src={avatarUrl({ id: c.contactId, ...c })} />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className={`truncate ${c.unread ? 'font-extrabold' : 'font-bold'}`}>
                        {name}
                      </span>
                      <span className="ml-auto shrink-0 text-[12px] text-muted">
                        {timeAgo(c.last.at)}
                      </span>
                    </span>
                    <span
                      className={`truncate text-[13px] ${c.unread ? 'text-ink' : 'text-muted'}`}
                    >
                      {c.last.direction === 'out' ? (c.last.byPerson ? 'You: ' : 'Flow: ') : ''}
                      {c.last.text}
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {c.unread > 0 && (
                        <span className="chip chip-lime px-1.5 py-0">{c.unread} new</span>
                      )}
                      {c.automationPausedAt && (
                        <span className="chip chip-orange px-1.5 py-0">
                          {c.automationResumeAt ? 'Bot paused' : 'Needs a person'}
                        </span>
                      )}
                      {c.status === 'closed' && <span className="chip px-1.5 py-0">Closed</span>}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className={`min-h-0 min-w-0 flex-col lg:flex ${id ? 'flex' : 'hidden'}`}>
        {id ? (
          <Conversation key={id} id={id} onChange={() => void list.reload()} />
        ) : (
          <div className="grid flex-1 place-items-center p-8">
            <EmptyState
              icon="inbox"
              title="Pick a conversation"
              body="Read the whole thread, reply, leave a note for your team, or take over from a flow."
            />
          </div>
        )}
      </main>
    </div>
  );
}

function Conversation({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, error, reload } = useApi<InboxDetail>(`/inbox/${id}`);
  usePolling(reload, 3000);
  const navigate = useNavigate();
  const end = useRef<HTMLDivElement>(null);
  const lastSeq = data?.messages.at(-1)?.seq;

  // New messages: scroll to them and mark them read.
  useEffect(() => {
    if (lastSeq === undefined) return;
    end.current?.scrollIntoView({ block: 'end' });
    if (document.visibilityState === 'visible')
      void api(`/inbox/${id}/read`, {}).then(onChange, () => {});
  }, [lastSeq, id, onChange]);

  if (error) return <p className="p-6 font-bold text-danger">This conversation doesn’t exist.</p>;
  if (!data) return <p className="p-6 text-muted">Loading…</p>;
  const c = data.contact;
  const name = contactName({ ...c, username: data.identities[0]?.username });
  const ig = data.identities.find((i) => i.channel === 'instagram');
  const refresh = () => {
    void reload();
    onChange();
  };

  const items = [
    ...data.messages.map((m) => ({ type: 'message' as const, at: m.at, m })),
    ...data.notes.map((n) => ({ type: 'note' as const, at: n.at, n })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <>
      <header className="grid gap-3 border-b-2 border-edge bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="linkbtn lg:hidden" onClick={() => navigate('/inbox')}>
            ← Inbox
          </button>
          <Avatar name={name} size={40} src={avatarUrl(c)} />
          <div className="min-w-0 flex-1">
            <Link to={`/contacts/${c.id}`} className="font-bold text-ink">
              {name}
            </Link>
            <p className="flex items-center gap-1.5 text-[13px] text-muted">
              {ig && <Icon icon={InstagramLogo} size={16} />}
              {ig?.username ? `@${ig.username}` : 'Instagram'}
              {ig?.followsUs ? ' · follows you' : ''}
            </p>
          </div>
          <select
            className="input w-auto py-1 text-[13px]"
            aria-label="Assigned to"
            value={c.assignedUserId ?? ''}
            onChange={async (e) => {
              await api(`/inbox/${id}/assign`, { userId: e.target.value || null });
              refresh();
            }}
          >
            <option value="">Unassigned</option>
            {data.team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              await api(`/inbox/${id}/status`, { status: c.status === 'open' ? 'closed' : 'open' });
              refresh();
            }}
          >
            {c.status === 'open' ? 'Close' : 'Reopen'}
          </button>
        </div>
        <BotStatus contact={c} onChange={refresh} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl gap-3">
          {items.map((it) =>
            it.type === 'note' ? (
              <div
                key={`n${it.n.id}`}
                className="mx-auto w-full max-w-md border-2 border-dashed border-accent bg-surface px-3 py-2 text-[14px]"
              >
                <p className="text-[12px] font-bold text-muted">
                  Note · {it.n.by} · {clock(it.n.at)}
                </p>
                <p className="whitespace-pre-wrap">{it.n.text}</p>
              </div>
            ) : (
              <Bubble key={it.m.id} m={it.m} />
            ),
          )}
          <div ref={end} />
        </div>
      </div>

      <Composer id={id} windowEndsAt={data.replyWindowEndsAt} onSent={refresh} />
    </>
  );
}

/** Whether flows answer this person right now, with the switch to change it. */
function BotStatus({
  contact: c,
  onChange,
}: {
  contact: InboxDetail['contact'];
  onChange: () => void;
}) {
  const paused = Boolean(c.automationPausedAt);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className={`chip ${paused ? 'chip-orange' : 'chip-success'}`}>
        {paused ? 'Bot paused' : 'Bot on'}
      </span>
      <span className="text-muted">
        {!paused
          ? 'Flows answer their messages. Replying here pauses them for 12 hours.'
          : c.automationResumeAt
            ? `You replied, so flows stay quiet until ${clock(c.automationResumeAt)}.`
            : 'Flows stay quiet until someone turns the bot back on.'}
      </span>
      <button
        type="button"
        className="linkbtn"
        onClick={async () => {
          await api(`/contacts/${c.id}/${paused ? 'resume' : 'pause'}-automation`, {});
          onChange();
        }}
      >
        {paused ? 'Turn the bot back on' : 'Pause the bot'}
      </button>
    </div>
  );
}

function Bubble({ m }: { m: InboxDetail['messages'][number] }) {
  const mine = m.direction === 'out';
  const c: InboxMessageContent = m.content;
  const label =
    c.kind === 'in'
      ? c.comment
        ? 'Commented on a post'
        : null
      : c.publicReplyTo
        ? 'Public reply under their comment'
        : c.privateReplyTo
          ? 'Private reply to their comment'
          : null;
  return (
    <div className={`grid max-w-[85%] gap-1 ${mine ? 'justify-self-end' : 'justify-self-start'}`}>
      <div
        className={`grid gap-2 border-2 px-3 py-2 text-[15px] ${
          mine
            ? m.by === 'Flow'
              ? 'border-primary bg-surface'
              : 'border-edge bg-surface-2'
            : c.kind === 'in' && c.comment
              ? 'border-dashed border-line bg-surface'
              : 'border-line bg-surface'
        }`}
      >
        {label && <p className="text-[12px] font-bold text-muted">{label}</p>}
        {c.kind === 'in' ? (
          <p className="whitespace-pre-wrap break-words">
            {c.text ?? (c.ref ? `Opened a link (ref=${c.ref})` : '(a photo or attachment)')}
          </p>
        ) : (
          <>
            {c.message.parts.map((p, i) =>
              p.type === 'text' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts have no ids and never reorder
                <p key={i} className="whitespace-pre-wrap break-words">
                  {p.text}
                </p>
              ) : p.type === 'image' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts have no ids and never reorder
                <img key={i} src={p.url} alt="" className="max-h-56 max-w-full" loading="lazy" />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts have no ids and never reorder
                <a key={i} href={p.url} target="_blank" rel="noopener noreferrer">
                  📄 {p.name}
                </a>
              ),
            )}
            {(c.message.buttons.length > 0 || c.message.quickReplies.length > 0) && (
              <span className="flex flex-wrap gap-1.5">
                {c.message.buttons.map((b) => (
                  <span key={b.id} className="chip">
                    {b.label}
                  </span>
                ))}
                {c.message.quickReplies.map((q) => (
                  <span key={q.id} className="chip chip-lime">
                    {q.label}
                  </span>
                ))}
              </span>
            )}
          </>
        )}
      </div>
      <p className={`text-[12px] text-muted ${mine ? 'text-right' : ''}`}>
        {mine ? `${m.by} · ` : ''}
        {clock(m.at)}
        {m.status === 'queued' && ' · sending…'}
      </p>
      {(m.status === 'failed' || m.status === 'blocked') && (
        <p className={`text-[12px] font-bold text-danger ${mine ? 'text-right' : ''}`}>
          Not sent: {m.error}
        </p>
      )}
    </div>
  );
}

/** Reply (to them) or note (to the team). Replies follow Instagram's 24-hour window. */
function Composer({
  id,
  windowEndsAt,
  onSent,
}: {
  id: string;
  windowEndsAt: string | null;
  onSent: () => void;
}) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [suggesting, setSuggesting] = useState(false);
  const open = windowEndsAt !== null && new Date(windowEndsAt).getTime() > Date.now();
  const canSend = mode === 'note' || open;

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!text.trim() || !canSend || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'note') await api(`/inbox/${id}/note`, { text });
      // A reply the channel refuses still lands in the thread, with the reason under it.
      else await api(`/inbox/${id}/reply`, { text });
      setText('');
      onSent();
    } catch {
      setError('Couldn’t send. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <form onSubmit={send} className="grid gap-2 border-t-2 border-edge bg-surface px-4 py-3">
      <div className="flex items-center gap-1 text-[13px]" role="tablist">
        {(['reply', 'note'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`border-2 px-2.5 py-0.5 font-bold ${mode === m ? 'border-edge bg-surface-2' : 'border-transparent'}`}
          >
            {m === 'reply' ? 'Reply' : 'Note to team'}
          </button>
        ))}
        {mode === 'reply' && (
          <span className="ml-auto text-muted">
            {open
              ? `You can reply until ${clock(windowEndsAt ?? '')}`
              : windowEndsAt
                ? 'Their last DM was over 24 hours ago, so Instagram won’t deliver a reply until they write again.'
                : 'They haven’t DMed yet: Instagram allows replies only after they message you.'}
          </span>
        )}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          className={`input min-h-[44px] flex-1 resize-y ${mode === 'note' ? 'border-dashed' : ''}`}
          rows={2}
          aria-label={mode === 'reply' ? 'Reply' : 'Note to your team'}
          placeholder={
            mode === 'reply'
              ? 'Write a reply… (Enter sends, Shift+Enter for a new line)'
              : 'Only your team sees notes.'
          }
          value={text}
          disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        {mode === 'reply' && canSend && (
          <button
            type="button"
            className="btn"
            disabled={suggesting}
            title="Draft a reply with AI. You can edit it before sending."
            onClick={async () => {
              setSuggesting(true);
              setError(undefined);
              try {
                const r = await api<{ text: string }>(`/inbox/${id}/suggest`, {});
                setText(r.text);
              } catch (err) {
                setError(
                  err instanceof ApiError && err.code.includes(' ')
                    ? err.code
                    : 'Couldn’t get a suggestion.',
                );
              } finally {
                setSuggesting(false);
              }
            }}
          >
            {suggesting ? '…' : '✨ Suggest'}
          </button>
        )}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!canSend || busy || !text.trim()}
        >
          {mode === 'reply' ? 'Send' : 'Add note'}
        </button>
      </div>
      <FormError message={error} />
    </form>
  );
}
