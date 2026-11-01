import { FacebookLogo, InstagramLogo } from '@phosphor-icons/react';
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
    // Beside the sidebar it fills the screen, so only the lists scroll and the reply box stays in
    // view. On phones the list scrolls with the page, and a conversation takes the whole screen.
    <div
      className={`grid min-[900px]:h-dvh lg:grid-cols-[360px_minmax(0,1fr)] ${id ? 'h-dvh' : ''}`}
    >
      <aside
        className={`min-h-0 flex-col border-edge bg-surface lg:flex lg:border-r-2 ${id ? 'hidden' : 'flex'}`}
        aria-label="Conversations"
      >
        <div className="grid gap-3 border-b-2 border-edge px-4 py-4">
          <h1 className="font-display text-display-sm font-bold">Inbox</h1>
          <div
            className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] lg:flex-wrap"
            role="tablist"
          >
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                onClick={() => setParams(v.id === 'open' ? {} : { view: v.id }, { replace: true })}
                className={`shrink-0 border-2 px-3 py-1.5 text-[14px] font-bold lg:px-2.5 lg:py-1 lg:text-[13px] ${view === v.id ? 'border-edge bg-surface-2 shadow-hard-sm' : 'border-line lg:border-transparent hover:border-line'}`}
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
        <ul className="min-h-0 flex-1 divide-y-2 divide-line lg:overflow-y-auto">
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
  // The channel they talk to us on (the first identity), named in the header and the reply box.
  const via = data.identities[0];
  const onFacebook = via?.channel === 'facebook';
  const channelName = onFacebook ? 'Facebook' : 'Instagram';
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
      <header className="border-b-2 border-edge bg-surface pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-2 py-2 pr-2 pl-1 sm:gap-3 sm:px-4 sm:py-3">
          <button
            type="button"
            className="grid size-11 shrink-0 place-items-center text-[22px] font-bold lg:hidden"
            aria-label="Back to the inbox"
            onClick={() => navigate('/inbox')}
          >
            ←
          </button>
          <Avatar name={name} size={40} src={avatarUrl(c)} />
          <div className="min-w-0 flex-1">
            <Link to={`/contacts/${c.id}`} className="block truncate font-bold text-ink">
              {name}
            </Link>
            <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
              {via && <Icon icon={onFacebook ? FacebookLogo : InstagramLogo} size={16} />}
              <span className="truncate">
                {via?.username ? `@${via.username}` : channelName}
                {ig?.followsUs ? ' · follows you' : ''}
              </span>
            </p>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <AssignSelect id={id} value={c.assignedUserId} team={data.team} onChange={refresh} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                await api(`/inbox/${id}/status`, {
                  status: c.status === 'open' ? 'closed' : 'open',
                });
                refresh();
              }}
            >
              {c.status === 'open' ? 'Close' : 'Reopen'}
            </button>
          </div>
          <ConversationMenu id={id} contact={c} team={data.team} onChange={refresh} />
        </div>
        <div className="px-4 pb-2.5">
          <BotStatus contact={c} onChange={refresh} />
        </div>
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

      <Composer
        id={id}
        channel={channelName}
        windowEndsAt={data.replyWindowEndsAt}
        onSent={refresh}
      />
    </>
  );
}

function AssignSelect({
  id,
  value,
  team,
  onChange,
  className = 'w-auto py-1 text-[13px]',
}: {
  id: string;
  value: string | null;
  team: InboxDetail['team'];
  onChange: () => void;
  className?: string;
}) {
  return (
    <select
      className={`input ${className}`}
      aria-label="Assigned to"
      value={value ?? ''}
      onChange={async (e) => {
        await api(`/inbox/${id}/assign`, { userId: e.target.value || null });
        onChange();
      }}
    >
      <option value="">Unassigned</option>
      {team.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}

/** Phones: assigning, closing and the contact page, behind one button. */
function ConversationMenu({
  id,
  contact: c,
  team,
  onChange,
}: {
  id: string;
  contact: InboxDetail['contact'];
  team: InboxDetail['team'];
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative sm:hidden">
      <button
        type="button"
        className="grid size-11 place-items-center border-2 border-transparent text-[22px] leading-none font-bold active:border-edge"
        aria-label="Conversation options"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close options"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-12 right-0 z-20 grid w-64 gap-3 border-2 border-edge bg-surface p-3 shadow-hard">
            <div className="grid gap-1">
              <span className="text-[13px] font-bold">Assigned to</span>
              <AssignSelect
                id={id}
                value={c.assignedUserId}
                team={team}
                className="w-full"
                onChange={() => {
                  setOpen(false);
                  onChange();
                }}
              />
            </div>
            <button
              type="button"
              className="btn btn-sm w-full"
              onClick={async () => {
                await api(`/inbox/${id}/status`, {
                  status: c.status === 'open' ? 'closed' : 'open',
                });
                setOpen(false);
                onChange();
              }}
            >
              {c.status === 'open' ? 'Close conversation' : 'Reopen conversation'}
            </button>
            <Link to={`/contacts/${c.id}`} className="btn btn-sm w-full">
              Contact details
            </Link>
          </div>
        </>
      )}
    </div>
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
      <span className="hidden text-muted sm:inline">
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
  channel,
  windowEndsAt,
  onSent,
}: {
  id: string;
  /** Instagram or Facebook, for the reply-window notes. */
  channel: string;
  windowEndsAt: string | null;
  onSent: () => void;
}) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [suggesting, setSuggesting] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // The box grows with what's typed, up to a point.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
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
    <form
      onSubmit={send}
      className="grid gap-2 border-t-2 border-edge bg-surface px-3 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] sm:px-4 sm:py-3"
    >
      <div className="flex flex-wrap items-center gap-1 text-[13px]" role="tablist">
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
          <span className="ml-auto text-right text-[12px] text-muted sm:text-[13px]">
            {open
              ? `You can reply until ${clock(windowEndsAt ?? '')}`
              : windowEndsAt
                ? `Their last message was over 24 hours ago, so ${channel} won’t deliver a reply until they write again.`
                : `They haven’t messaged yet: ${channel} allows replies only after they do.`}
          </span>
        )}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={box}
          className={`input max-h-40 min-h-[44px] min-w-0 flex-1 resize-none ${mode === 'note' ? 'border-dashed' : ''}`}
          rows={1}
          aria-label={mode === 'reply' ? 'Reply' : 'Note to your team'}
          placeholder={mode === 'reply' ? 'Write a reply…' : 'Only your team sees notes.'}
          value={text}
          disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        {mode === 'reply' && canSend && (
          <button
            type="button"
            className="btn shrink-0 px-3 sm:px-5"
            disabled={suggesting}
            aria-label="Suggest a reply with AI"
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
            {suggesting ? '…' : '✨'}
            <span className="hidden sm:inline">{suggesting ? '' : 'Suggest'}</span>
          </button>
        )}
        <button
          type="submit"
          className="btn btn-primary shrink-0 px-4"
          disabled={!canSend || busy || !text.trim()}
        >
          {mode === 'reply' ? 'Send' : 'Add note'}
        </button>
      </div>
      <FormError message={error} />
    </form>
  );
}
