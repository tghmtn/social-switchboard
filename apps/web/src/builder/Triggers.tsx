import type { TriggerConfig } from '@social-switchboard/flow';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, type InstagramMedia, type Trigger, useApi } from '../api';
import { Field, FormError, Select, TextArea, Toggle } from '../ui';

const MATCH_TEXT = { exact: '', contains: ' (anywhere)', starts_with: ' (starts with)' } as const;

export function triggerText(c: TriggerConfig): string {
  switch (c.type) {
    case 'keyword':
      return `${c.keywords.join(', ')}${MATCH_TEXT[c.match]}`;
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
  const [type, setType] = useState<TriggerConfig['type']>('keyword');
  const [error, setError] = useState<string>();
  const [posts, setPosts] = useState<string[]>([]);

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
          mediaIds: posts,
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
      setPosts([]);
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
      <div className="grid gap-2">
        {triggers.length === 0 && <p className="text-[14px] text-muted">No triggers yet.</p>}
        {triggers.map((t) => (
          <div key={t.id} className="flex items-center gap-3 border-2 border-line p-3">
            <div className="min-w-0 flex-1">
              <p className="text-label uppercase text-muted">{t.config.type.replace('_', ' ')}</p>
              <p className="font-bold break-words">{triggerText(t.config)}</p>
              {t.config.type === 'comment' && t.config.publicReplies.length > 0 && (
                <p className="text-[13px] text-muted">
                  Public reply:{' '}
                  {t.config.publicReplies.length === 1
                    ? `“${t.config.publicReplies[0]}”`
                    : `${t.config.publicReplies.length} variations`}
                </p>
              )}
            </div>
            <Toggle
              on={t.enabled}
              label={`Turn ${t.enabled ? 'off' : 'on'} trigger ${triggerText(t.config)}`}
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
        ))}
      </div>

      <form onSubmit={add} className="grid gap-3 border-t-2 border-line pt-4">
        <Select
          label="Add a trigger"
          value={type}
          onChange={(e) => setType(e.target.value as TriggerConfig['type'])}
        >
          <option value="keyword">Keyword in a DM</option>
          <option value="comment">Comment on a post</option>
          <option value="welcome">New contact’s first message</option>
          <option value="default_reply">Default reply (nothing else matched)</option>
          <option value="ref">Entry link with a ref</option>
        </Select>

        {(type === 'keyword' || type === 'comment') && (
          <>
            <Field
              label={type === 'comment' ? 'Keywords (optional)' : 'Keywords'}
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
            <PostPicker selected={posts} onChange={setPosts} />
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
    </div>
  );
}

/** Pick which posts a comment trigger watches; none picked means any post. */
function PostPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { data, error, loading } = useApi<{ media: InstagramMedia[] }>('/instagram/media');
  const notConnected = error instanceof ApiError && error.status === 409;

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-bold">Which posts</legend>
      {loading && <p className="text-[13px] text-muted">Loading your recent posts…</p>}
      {notConnected && (
        <p className="text-[13px] text-muted">
          Watches every post. <Link to="/channels">Connect Instagram</Link> to pick specific ones.
        </p>
      )}
      {error && !notConnected && (
        <p className="text-[13px] text-danger">
          Couldn’t load posts: {error.message}. It will watch every post.
        </p>
      )}
      {data && (
        <>
          <p className="text-[13px] text-muted">
            {selected.length === 0
              ? 'Any post. Pick posts to limit it.'
              : `${selected.length} picked.`}
          </p>
          <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto pr-1">
            {data.media.map((m) => {
              const on = selected.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={on}
                  title={m.caption || m.kind}
                  onClick={() =>
                    onChange(on ? selected.filter((x) => x !== m.id) : [...selected, m.id])
                  }
                  className={`relative aspect-square overflow-hidden border-2 ${on ? 'border-primary shadow-hard-sm' : 'border-line'}`}
                >
                  {m.thumbnail ? (
                    <img
                      src={m.thumbnail}
                      alt={m.caption || `${m.kind} from ${m.timestamp?.slice(0, 10) ?? ''}`}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center bg-surface-2 p-1 text-[11px]">
                      {m.caption || m.kind}
                    </span>
                  )}
                  {on && <span className="chip chip-lime absolute top-1 right-1 px-1 py-0">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </fieldset>
  );
}
