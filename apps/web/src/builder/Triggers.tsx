import type { TriggerConfig } from '@social-switchboard/flow';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, type InstagramMedia, type Trigger } from '../api';
import { Dialog, Field, FormError, Select, TextArea, Toggle } from '../ui';

const MATCH_TEXT = { exact: '', contains: ' (anywhere)', starts_with: ' (starts with)' } as const;

export const TRIGGER_TYPES: Record<TriggerConfig['type'], string> = {
  comment: 'Comment on a post',
  keyword: 'DM keyword',
  welcome: 'First message',
  default_reply: 'Default reply',
  ref: 'Entry link',
};

/** "When someone…": the add-trigger choices, finishing the sentence. */
const WHEN: Record<TriggerConfig['type'], string> = {
  comment: 'comments on a post',
  keyword: 'sends a DM with a keyword',
  welcome: 'messages you for the first time',
  default_reply: 'sends a DM nothing else answers',
  ref: 'opens an entry link',
};

const MATCH_LABEL = {
  exact: 'the whole message',
  contains: 'anywhere, as a whole word',
  starts_with: 'at the start',
} as const;

export function triggerText(c: TriggerConfig): string {
  switch (c.type) {
    case 'keyword':
      return `DM: ${c.keywords.join(', ')}${MATCH_TEXT[c.match]}`;
    case 'welcome':
      return 'New contact’s first message';
    case 'default_reply':
      return 'Anything else (default reply)';
    case 'ref':
      return `Link ref=${c.ref}`;
    case 'comment': {
      const words = c.keywords.length
        ? `“${c.keywords.join('”, “')}”${MATCH_TEXT[c.match]}`
        : 'any comment';
      const where = c.mediaIds.length
        ? `on ${c.mediaIds.length} post${c.mediaIds.length === 1 ? '' : 's'}`
        : 'on any post';
      return `Comment: ${words} ${where}`;
    }
  }
}

const splitList = (raw: FormDataEntryValue | null, sep: RegExp) =>
  String(raw ?? '')
    .split(sep)
    .map((k) => k.trim())
    .filter(Boolean);

/** Asked of the post picker: what's picked now, and what to do with the new choice. */
type PostRequest = { selected: string[]; onDone: (ids: string[]) => void | Promise<void> };

/** Shown when the start step is selected: what starts this flow. */
export function TriggersEditor({
  flowId,
  triggers,
  published,
  onChange,
}: {
  flowId: string;
  triggers: Trigger[];
  published: boolean;
  onChange: () => void;
}) {
  const posts = useRecentPosts();
  const [type, setType] = useState<TriggerConfig['type']>('comment');
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const [choosing, setChoosing] = useState<PostRequest>();

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const match = form.get('match') as 'exact' | 'contains' | 'starts_with';
    let config: TriggerConfig;
    switch (type) {
      case 'keyword':
        config = { type, keywords: splitList(form.get('keywords'), /,/), match };
        break;
      case 'ref':
        config = { type, ref: String(form.get('ref') ?? '').trim() };
        break;
      case 'comment':
        config = {
          type,
          keywords: splitList(form.get('keywords'), /,/),
          match,
          mediaIds: picked,
          publicReplies: splitList(form.get('publicReplies'), /\n/),
        };
        break;
      default:
        config = { type };
    }
    setError(undefined);
    try {
      await api('/triggers', { flowId, config });
      formEl.reset();
      setPicked([]);
      onChange();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_input'
          ? 'Check the keywords, ref or replies (refs use letters, numbers, _ and -).'
          : 'Couldn’t add the trigger.',
      );
    }
  }

  return (
    <div className="grid gap-4">
      <h2 className="text-lg font-bold">What starts this flow</h2>
      {!published && (
        <p className="border-2 border-accent bg-surface px-3 py-2 text-[14px]">
          Triggers only fire once the flow is published. Use “Run this draft” in the Test tab before
          then.
        </p>
      )}
      <p className="text-[14px] text-muted">
        Each trigger is one way into this flow, with its own keywords. A flow can have several, like
        a comment trigger and a DM keyword trigger.
      </p>
      <div className="grid gap-2">
        {triggers.length === 0 && <p className="text-[14px] text-muted">No triggers yet.</p>}
        {triggers.map((t) => {
          const c = t.config;
          return (
            <div key={t.id} className="grid gap-2 border-2 border-line p-3">
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 font-bold">{TRIGGER_TYPES[c.type]}</p>
                <Toggle
                  on={t.enabled}
                  label={`Turn ${t.enabled ? 'off' : 'on'} trigger ${triggerText(c)}`}
                  onChange={async (on) => {
                    await api(`/triggers/${t.id}`, { enabled: on }, 'PATCH');
                    onChange();
                  }}
                />
                <button
                  type="button"
                  className="linkbtn text-[13px] text-danger"
                  onClick={async () => {
                    await api(`/triggers/${t.id}`, undefined, 'DELETE');
                    onChange();
                  }}
                >
                  Remove
                </button>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-[14px]">
                {c.type === 'comment' && (
                  <>
                    <dt className="text-muted">Posts</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <PostStrip ids={c.mediaIds} posts={posts.items} />
                      {posts.state !== 'not_connected' && (
                        <button
                          type="button"
                          className="linkbtn text-[13px]"
                          onClick={() =>
                            setChoosing({
                              selected: c.mediaIds,
                              onDone: async (ids) => {
                                await api(
                                  `/triggers/${t.id}`,
                                  { config: { ...c, mediaIds: ids } },
                                  'PATCH',
                                );
                                onChange();
                              },
                            })
                          }
                        >
                          {c.mediaIds.length ? 'Change' : 'Pick posts'}
                        </button>
                      )}
                    </dd>
                  </>
                )}
                {(c.type === 'comment' || c.type === 'keyword') && (
                  <>
                    <dt className="text-muted">Keywords</dt>
                    <dd className="break-words">
                      {c.keywords.length ? (
                        <>
                          <b>{c.keywords.join(', ')}</b>{' '}
                          <span className="text-muted">({MATCH_LABEL[c.match]})</span>
                        </>
                      ) : (
                        'Any comment'
                      )}
                    </dd>
                  </>
                )}
                {c.type === 'comment' && c.publicReplies.length > 0 && (
                  <>
                    <dt className="text-muted">Reply</dt>
                    <dd className="break-words">
                      {c.publicReplies.length === 1
                        ? `“${c.publicReplies[0]}”`
                        : `${c.publicReplies.length} variations`}
                    </dd>
                  </>
                )}
                {c.type === 'ref' && (
                  <>
                    <dt className="text-muted">Ref</dt>
                    <dd className="break-words">{c.ref}</dd>
                  </>
                )}
              </dl>
            </div>
          );
        })}
      </div>

      <form onSubmit={add} className="grid gap-3 border-t-2 border-line pt-4">
        <h3 className="font-bold">Add a trigger</h3>
        <Select
          label="When someone…"
          value={type}
          onChange={(e) => setType(e.target.value as TriggerConfig['type'])}
        >
          {(Object.keys(WHEN) as TriggerConfig['type'][]).map((k) => (
            <option key={k} value={k}>
              {WHEN[k]}
            </option>
          ))}
        </Select>

        {type === 'comment' && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-bold">On which posts</legend>
            {posts.state === 'not_connected' ? (
              <p className="text-[13px] text-muted">
                Every post. <Link to="/channels">Connect Instagram</Link> to pick specific ones.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <PostStrip ids={picked} posts={posts.items} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setChoosing({ selected: picked, onDone: setPicked })}
                >
                  {picked.length ? 'Change posts' : 'Pick posts'}
                </button>
              </div>
            )}
          </fieldset>
        )}

        {(type === 'keyword' || type === 'comment') && (
          <>
            <Field
              label={type === 'comment' ? 'With these keywords (optional)' : 'Keywords'}
              name="keywords"
              required={type === 'keyword'}
              placeholder="WORKSHOP, workshop info"
              hint={
                type === 'comment'
                  ? 'Leave empty to answer every comment. Separate several with commas.'
                  : 'Separate several with commas. Case and punctuation don’t matter.'
              }
            />
            <Select
              key={type}
              label="Match"
              name="match"
              defaultValue={type === 'comment' ? 'contains' : 'exact'}
            >
              <option value="exact">The whole message</option>
              <option value="contains">Anywhere, as a whole word</option>
              <option value="starts_with">The start of the message</option>
            </Select>
          </>
        )}

        {type === 'comment' && (
          <>
            <TextArea
              label="Public replies under the comment (optional)"
              name="publicReplies"
              rows={3}
              placeholder={'Check your DMs! 📩\nSent you a message 💌'}
              hint="One per line. Each comment gets one, picked at random, so replies don’t all look the same."
            />
            <p className="border-2 border-line bg-surface-2 px-3 py-2 text-[13px]">
              The flow’s first message is sent as Instagram’s private reply to the comment.
              Instagram allows only one until they write back, so give that first message a quick
              reply or button.
            </p>
          </>
        )}

        {type === 'ref' && (
          <Field
            label="Ref"
            name="ref"
            required
            placeholder="spring-sale"
            hint="ig.me/m/you?ref=spring-sale"
          />
        )}
        <button type="submit" className="btn w-fit">
          Add trigger
        </button>
        <FormError message={error} />
      </form>

      <PostDialog request={choosing} posts={posts} onClose={() => setChoosing(undefined)} />
    </div>
  );
}

/** The account's posts, newest first, a page at a time. */
function useRecentPosts() {
  const [items, setItems] = useState<InstagramMedia[]>([]);
  const [after, setAfter] = useState<string>();
  const [state, setState] = useState<'loading' | 'ready' | 'not_connected' | 'error'>('loading');
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    try {
      const page = await api<{ media: InstagramMedia[]; after?: string }>(
        `/instagram/media${cursor ? `?${new URLSearchParams({ after: cursor })}` : ''}`,
      );
      setItems((prev) => (cursor ? [...prev, ...page.media] : page.media));
      setAfter(page.after);
      setState('ready');
      setError(undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return setState('not_connected');
      setError(err instanceof Error ? err.message : String(err));
      if (!cursor) setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!after) return;
    setLoadingMore(true);
    await load(after);
    setLoadingMore(false);
  }

  return { items, after, state, error, loadingMore, loadMore };
}

type RecentPosts = ReturnType<typeof useRecentPosts>;

const postKind = (m: InstagramMedia) => (m.kind === 'carousel_album' ? 'carousel' : m.kind);
const postDate = (m: InstagramMedia) =>
  m.timestamp
    ? new Date(m.timestamp).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

/** One post, whole (never cropped), in a portrait tile like Instagram's grid. */
function PostThumb({ post, className = '' }: { post?: InstagramMedia; className?: string }) {
  return (
    <span
      className={`flex aspect-[4/5] items-center justify-center overflow-hidden bg-surface-2 ${className}`}
      title={post?.caption || undefined}
    >
      {post?.thumbnail ? (
        <img
          src={post.thumbnail}
          alt={post.caption || `${postKind(post)} from ${postDate(post)}`}
          className="size-full object-contain"
          loading="lazy"
        />
      ) : (
        <span className="p-1 text-center text-[11px] text-muted">
          {post ? postKind(post) : 'Older post'}
        </span>
      )}
    </span>
  );
}

/** The posts a comment trigger watches, as small thumbnails. */
function PostStrip({ ids, posts }: { ids: string[]; posts: InstagramMedia[] }) {
  if (ids.length === 0) return <span className="text-[13px] text-muted">Every post</span>;
  const byId = new Map(posts.map((p) => [p.id, p]));
  return (
    <span className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <PostThumb key={id} post={byId.get(id)} className="w-12 border-2 border-line" />
      ))}
    </span>
  );
}

/** Pick which posts a comment trigger watches; none picked means any post, new ones included. */
function PostDialog({
  request,
  posts,
  onClose,
}: {
  request?: PostRequest;
  posts: RecentPosts;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (request) setSelected(request.selected);
  }, [request]);
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function done() {
    setSaving(true);
    try {
      await request?.onDone(selected);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(request)} onClose={onClose} title="Which posts?">
      <div className="grid gap-4">
        <p className="text-[14px] text-muted">
          Pick the posts this trigger watches. Pick none to watch every post, including new ones.
        </p>
        {posts.state === 'loading' && <p className="text-[14px]">Loading your posts…</p>}
        {posts.error && <FormError message={`Couldn’t load posts: ${posts.error}`} />}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {posts.items.map((m) => {
            const on = selected.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(m.id)}
                className={`relative grid gap-1 border-2 p-1.5 text-left ${on ? 'border-primary bg-surface-2 shadow-hard-sm' : 'border-line hover:border-edge'}`}
              >
                <PostThumb post={m} className="w-full" />
                <span className="truncate text-[12px] text-muted">
                  {postDate(m)}
                  {m.kind === 'image' ? '' : ` · ${postKind(m)}`}
                </span>
                {on && <span className="chip chip-lime absolute top-2 right-2 px-1.5 py-0">✓</span>}
              </button>
            );
          })}
        </div>
        {posts.after && (
          <button
            type="button"
            className="btn btn-sm w-fit"
            disabled={posts.loadingMore}
            onClick={() => void posts.loadMore()}
          >
            {posts.loadingMore ? 'Loading…' : 'Show older posts'}
          </button>
        )}
      </div>
      <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 flex flex-wrap items-center justify-between gap-3 border-t-2 border-edge bg-surface px-5 py-3">
        <span className="text-[14px] font-bold">
          {selected.length === 0 ? 'Every post' : `${selected.length} picked`}
        </span>
        <div className="flex gap-2">
          {selected.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => setSelected([])}>
              Clear
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving}
            onClick={() => void done()}
          >
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}
