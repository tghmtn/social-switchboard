import { type TriggerConfig, triggerOverlap } from '@social-switchboard/flow';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, type InstagramMedia, type Trigger, useApi } from '../api';
import { Dialog, Field, FormError, Select, TextArea, Toggle } from '../ui';

const MATCH_TEXT = { exact: '', contains: ' (anywhere)', starts_with: ' (starts with)' } as const;

export const TRIGGER_TYPES: Record<TriggerConfig['type'], string> = {
  comment: 'Comment on a post',
  keyword: 'DM keyword',
  story_reply: 'Story reply',
  story_mention: 'Story mention',
  welcome: 'First message',
  default_reply: 'Default reply',
  ref: 'Entry link',
};

/** "When someone…": the add-trigger choices, finishing the sentence. */
const WHEN: Record<TriggerConfig['type'], string> = {
  comment: 'comments on a post',
  keyword: 'sends a DM with a keyword',
  story_reply: 'replies to your story',
  story_mention: 'mentions you in their story',
  welcome: 'messages you for the first time',
  default_reply: 'sends a DM nothing else answers',
  ref: 'opens an entry link',
};

/** Where a trigger listens, saved as its channels ("all" saves none: every platform). */
type Platform = 'instagram' | 'facebook' | 'webchat' | 'all';
const PLATFORMS: Record<Platform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  webchat: 'Website chat',
  all: 'Every platform',
};
/** What can start an automation on each platform. */
const TYPES_ON: Record<Platform, TriggerConfig['type'][]> = {
  instagram: [
    'comment',
    'keyword',
    'story_reply',
    'story_mention',
    'welcome',
    'default_reply',
    'ref',
  ],
  facebook: ['comment', 'keyword', 'welcome', 'default_reply', 'ref'],
  webchat: ['keyword', 'welcome', 'default_reply'],
  all: ['keyword', 'comment', 'welcome', 'default_reply', 'ref'],
};
const channelsFor = (p: Platform) => (p === 'all' ? null : [p]);
/** The platforms a trigger of this type can listen on. */
const platformsFor = (type: TriggerConfig['type']) =>
  (Object.keys(TYPES_ON) as Platform[]).filter((p) => TYPES_ON[p].includes(type));
const platformOf = (channels: string[] | null): Platform =>
  channels?.length === 1 && channels[0] && channels[0] in PLATFORMS && channels[0] !== 'all'
    ? (channels[0] as Platform)
    : 'all';
const platformText = (channels: string[] | null) =>
  channels?.length
    ? channels.map((c) => (c in PLATFORMS ? PLATFORMS[c as Platform] : c)).join(' and ')
    : PLATFORMS.all;

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
    case 'story_reply': {
      const words = c.keywords.length
        ? `“${c.keywords.join('”, “')}”${MATCH_TEXT[c.match]}`
        : 'any reply';
      const where = c.storyIds.length
        ? `to ${c.storyIds.length} stor${c.storyIds.length === 1 ? 'y' : 'ies'}`
        : 'to any story';
      return `Story reply: ${words} ${where}`;
    }
    case 'story_mention':
      return 'Mentioned in their story';
  }
}

const splitList = (raw: FormDataEntryValue | null, sep: RegExp) =>
  String(raw ?? '')
    .split(sep)
    .map((k) => k.trim())
    .filter(Boolean);

/** A trigger's keywords, with a Change link to edit them in place. */
function KeywordsRow({
  id,
  config,
  onChange,
}: {
  id: string;
  config: Extract<TriggerConfig, { type: 'keyword' | 'comment' | 'story_reply' }>;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const keywords = splitList(new FormData(e.currentTarget).get('keywords'), /,/);
    if (config.type === 'keyword' && keywords.length === 0)
      return setError('Add at least one keyword.');
    try {
      await api(`/triggers/${id}`, { config: { ...config, keywords } }, 'PATCH');
      setEditing(false);
      setError(undefined);
      onChange();
    } catch {
      setError('Couldn’t save the keywords.');
    }
  }

  return (
    <>
      <dt className="text-muted">Keywords</dt>
      <dd className="break-words">
        {editing ? (
          <form onSubmit={save} className="grid gap-2">
            <input
              name="keywords"
              className="input"
              aria-label="Keywords, separated by commas"
              defaultValue={config.keywords.join(', ')}
              placeholder={
                config.type === 'comment'
                  ? 'Empty: any comment'
                  : config.type === 'story_reply'
                    ? 'Empty: any reply'
                    : 'WORKSHOP'
              }
              // biome-ignore lint/a11y/noAutofocus: opened by the Change button just pressed
              autoFocus
            />
            <FormError message={error} />
            <div className="flex gap-2">
              <button type="submit" className="btn btn-sm btn-primary">
                Save
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setEditing(false);
                  setError(undefined);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            {config.keywords.length ? (
              <>
                <b>{config.keywords.join(', ')}</b>{' '}
                <span className="text-muted">({MATCH_LABEL[config.match]})</span>
              </>
            ) : config.type === 'story_reply' ? (
              'Any reply'
            ) : (
              'Any comment'
            )}{' '}
            <button type="button" className="linkbtn text-[13px]" onClick={() => setEditing(true)}>
              Change
            </button>
          </>
        )}
      </dd>
    </>
  );
}

/** Asked of the post picker: posts or stories, what's picked now, and what to do with the choice. */
type PostRequest = {
  kind: 'posts' | 'stories';
  selected: string[];
  onDone: (ids: string[]) => void | Promise<void>;
};

/** Shown when the start step is selected: what starts this automation. */
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
  const posts = useRecentPosts('/instagram/media');
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [type, setType] = useState<TriggerConfig['type']>('comment');
  // Stories are only asked for when a story trigger needs them (each look asks Instagram).
  const stories = useRecentPosts(
    '/instagram/stories',
    type === 'story_reply' || triggers.some((t) => t.config.type === 'story_reply'),
  );
  // Live triggers elsewhere, to warn when one here answers the same thing.
  const all = useApi<{ triggers: Trigger[] }>('/triggers');
  const others = (all.data?.triggers ?? []).filter(
    (o) => o.flowId !== flowId && o.enabled && o.flowPublished,
  );
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedStories, setPickedStories] = useState<string[]>([]);

  function choosePlatform(p: Platform) {
    setPlatform(p);
    if (!TYPES_ON[p].includes(type)) setType(TYPES_ON[p][0] ?? 'keyword');
  }
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
      case 'story_reply':
        config = {
          type,
          keywords: splitList(form.get('keywords'), /,/),
          match,
          storyIds: pickedStories,
        };
        break;
      default:
        config = { type };
    }
    setError(undefined);
    try {
      await api('/triggers', { flowId, config, channels: channelsFor(platform) });
      formEl.reset();
      setPicked([]);
      setPickedStories([]);
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
      <h2 className="text-lg font-bold">What starts this automation</h2>
      {!published && (
        <p className="border-2 border-accent bg-surface px-3 py-2 text-[14px]">
          Triggers only fire once the automation is published. Use “Run this draft” in the Test tab
          before then.
        </p>
      )}
      <p className="text-[14px] text-muted">
        Each trigger is one way into this automation, with its own keywords. An automation can have
        several, like a comment trigger and a DM keyword trigger.
      </p>
      <div className="grid gap-2">
        {triggers.length === 0 && <p className="text-[14px] text-muted">No triggers yet.</p>}
        {triggers.map((t) => {
          const c = t.config;
          return (
            <div key={t.id} className="grid gap-2 border-2 border-line p-3">
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 font-bold">{TRIGGER_TYPES[c.type]}</p>
                {/* Where there's a choice, the Platform row below shows it instead. */}
                {platformsFor(c.type).length === 1 && (
                  <span className="chip">{platformText(t.channels)}</span>
                )}
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
                {platformsFor(c.type).length > 1 && (
                  <>
                    <dt className="text-muted">
                      <label htmlFor={`platform-${t.id}`}>Platform</label>
                    </dt>
                    <dd>
                      <select
                        id={`platform-${t.id}`}
                        className="input w-auto py-1 text-[14px]"
                        value={platformOf(t.channels)}
                        onChange={async (e) => {
                          await api(
                            `/triggers/${t.id}`,
                            { channels: channelsFor(e.target.value as Platform) },
                            'PATCH',
                          );
                          onChange();
                        }}
                      >
                        {platformsFor(c.type).map((p) => (
                          <option key={p} value={p}>
                            {PLATFORMS[p]}
                          </option>
                        ))}
                      </select>
                    </dd>
                  </>
                )}
                {c.type === 'story_reply' && (
                  <>
                    <dt className="text-muted">Stories</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <PostStrip
                        ids={c.storyIds}
                        posts={stories.items}
                        every="Every story"
                        missing="Ended story"
                      />
                      {stories.state !== 'not_connected' && (
                        <button
                          type="button"
                          className="linkbtn text-[13px]"
                          onClick={() =>
                            setChoosing({
                              kind: 'stories',
                              selected: c.storyIds,
                              onDone: async (ids) => {
                                await api(
                                  `/triggers/${t.id}`,
                                  { config: { ...c, storyIds: ids } },
                                  'PATCH',
                                );
                                onChange();
                              },
                            })
                          }
                        >
                          {c.storyIds.length ? 'Change' : 'Pick stories'}
                        </button>
                      )}
                    </dd>
                  </>
                )}
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
                              kind: 'posts',
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
                {(c.type === 'comment' || c.type === 'keyword' || c.type === 'story_reply') && (
                  <KeywordsRow id={t.id} config={c} onChange={onChange} />
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
              {t.enabled &&
                others.flatMap((o) => {
                  const what = triggerOverlap(t, o);
                  return what
                    ? [
                        <p
                          key={o.id}
                          className="border-2 border-accent bg-surface px-3 py-2 text-[13px]"
                        >
                          <Link to={`/automations/${o.flowId}`}>{o.flowName}</Link> also answers{' '}
                          {what}, and only one of them runs. Change one of them, or turn one off.
                        </p>,
                      ]
                    : [];
                })}
            </div>
          );
        })}
      </div>

      <form onSubmit={add} className="grid gap-3 border-t-2 border-line pt-4">
        <h3 className="font-bold">Add a trigger</h3>
        <Select
          label="Platform"
          value={platform}
          onChange={(e) => choosePlatform(e.target.value as Platform)}
        >
          {(Object.keys(PLATFORMS) as Platform[]).map((p) => (
            <option key={p} value={p}>
              {PLATFORMS[p]}
            </option>
          ))}
        </Select>
        <Select
          label="When someone…"
          value={type}
          onChange={(e) => setType(e.target.value as TriggerConfig['type'])}
        >
          {TYPES_ON[platform].map((k) => (
            <option key={k} value={k}>
              {WHEN[k]}
            </option>
          ))}
        </Select>

        {type === 'comment' && platform === 'facebook' && (
          <p className="text-[13px] text-muted">Answers comments on any of the Page’s posts.</p>
        )}
        {type === 'comment' && platform !== 'facebook' && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-bold">On which posts</legend>
            {posts.state === 'not_connected' ? (
              <p className="text-[13px] text-muted">
                Every post. <Link to="/channels/instagram">Connect Instagram</Link> to pick specific
                ones.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <PostStrip ids={picked} posts={posts.items} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setChoosing({ kind: 'posts', selected: picked, onDone: setPicked })
                  }
                >
                  {picked.length ? 'Change posts' : 'Pick posts'}
                </button>
              </div>
            )}
          </fieldset>
        )}

        {type === 'story_reply' && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-bold">On which stories</legend>
            {stories.state === 'not_connected' ? (
              <p className="text-[13px] text-muted">
                Every story. <Link to="/channels/instagram">Connect Instagram</Link> to pick
                specific ones.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <PostStrip ids={pickedStories} posts={stories.items} every="Every story" />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setChoosing({
                      kind: 'stories',
                      selected: pickedStories,
                      onDone: setPickedStories,
                    })
                  }
                >
                  {pickedStories.length ? 'Change stories' : 'Pick stories'}
                </button>
              </div>
            )}
          </fieldset>
        )}

        {type === 'story_mention' && (
          <p className="border-2 border-line bg-surface-2 px-3 py-2 text-[13px]">
            Fires when someone tags you in their own story. That counts as them messaging you, so
            the automation can DM them back, like a thank-you with a link.
          </p>
        )}

        {(type === 'keyword' || type === 'comment' || type === 'story_reply') && (
          <>
            <Field
              label={type === 'keyword' ? 'Keywords' : 'With these keywords (optional)'}
              name="keywords"
              required={type === 'keyword'}
              placeholder="WORKSHOP, workshop info"
              hint={
                type === 'comment'
                  ? 'Leave empty to answer every comment. Separate several with commas.'
                  : type === 'story_reply'
                    ? 'Leave empty to answer every reply. Separate several with commas.'
                    : 'Separate several with commas. Case and punctuation don’t matter.'
              }
            />
            <Select
              key={type}
              label="Match"
              name="match"
              defaultValue={type === 'keyword' ? 'exact' : 'contains'}
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
              The automation’s first message is sent as Instagram’s private reply to the comment.
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
            hint={
              platform === 'facebook'
                ? 'm.me/yourpage?ref=spring-sale'
                : platform === 'instagram'
                  ? 'ig.me/m/you?ref=spring-sale'
                  : 'ig.me/m/you?ref=spring-sale or m.me/yourpage?ref=spring-sale'
            }
          />
        )}
        <button type="submit" className="btn w-fit">
          Add trigger
        </button>
        <FormError message={error} />
      </form>

      <PostDialog
        request={choosing}
        posts={choosing?.kind === 'stories' ? stories : posts}
        onClose={() => setChoosing(undefined)}
      />
    </div>
  );
}

/** The account's posts (or stories), newest first, a page at a time, once `wanted`. */
function useRecentPosts(path: '/instagram/media' | '/instagram/stories', wanted = true) {
  const [items, setItems] = useState<InstagramMedia[]>([]);
  const [after, setAfter] = useState<string>();
  const [state, setState] = useState<'loading' | 'ready' | 'not_connected' | 'error'>('loading');
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await api<{ media: InstagramMedia[]; after?: string }>(
          `${path}${cursor ? `?${new URLSearchParams({ after: cursor })}` : ''}`,
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
    },
    [path],
  );

  useEffect(() => {
    if (wanted) void load();
  }, [load, wanted]);

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
export function PostThumb({
  post,
  className = '',
  missing = 'Older post',
}: {
  post?: InstagramMedia;
  className?: string;
  /** Shown when the post isn't among those loaded. */
  missing?: string;
}) {
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
          {post ? postKind(post) : missing}
        </span>
      )}
    </span>
  );
}

/** The posts (or stories) a trigger watches, as small thumbnails. */
function PostStrip({
  ids,
  posts,
  every = 'Every post',
  missing,
}: {
  ids: string[];
  posts: InstagramMedia[];
  every?: string;
  missing?: string;
}) {
  if (ids.length === 0) return <span className="text-[13px] text-muted">{every}</span>;
  const byId = new Map(posts.map((p) => [p.id, p]));
  return (
    <span className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <PostThumb
          key={id}
          post={byId.get(id)}
          missing={missing}
          className="w-12 border-2 border-line"
        />
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
  const stories = request?.kind === 'stories';
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
    <Dialog
      open={Boolean(request)}
      onClose={onClose}
      title={stories ? 'Which stories?' : 'Which posts?'}
    >
      <div className="grid gap-4">
        <p className="text-[14px] text-muted">
          {stories
            ? 'Pick the stories this trigger watches. Instagram only shows stories from the last 24 hours, and a picked story stops getting replies once it ends. Pick none to answer replies to every story, including new ones.'
            : 'Pick the posts this trigger watches. Pick none to watch every post, including new ones.'}
        </p>
        {posts.state === 'loading' && (
          <p className="text-[14px]">{stories ? 'Loading your stories…' : 'Loading your posts…'}</p>
        )}
        {posts.error && (
          <FormError message={`Couldn’t load ${stories ? 'stories' : 'posts'}: ${posts.error}`} />
        )}
        {stories && posts.state === 'ready' && posts.items.length === 0 && (
          <p className="text-[14px]">No stories in the last 24 hours.</p>
        )}
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
          {selected.length === 0
            ? stories
              ? 'Every story'
              : 'Every post'
            : `${selected.length} picked`}
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
