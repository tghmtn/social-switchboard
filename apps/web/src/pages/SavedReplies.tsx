import { type FormEvent, useState } from 'react';
import { ApiError, api, type SavedReply, useApi } from '../api';
import { Field, FormError } from '../ui';

// Settings → Saved replies: what the team often says in the inbox. In a conversation, type / in
// the reply box (or tap ⚡) to pick one; {{variables}} fill in from the contact.

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? (Object.values(err.fieldErrors())[0] ?? (err.code.includes(' ') ? err.code : fallback))
    : fallback;

export function RepliesSection() {
  const replies = useApi<{ replies: SavedReply[] }>('/saved-replies');
  const [editing, setEditing] = useState<string>();
  const list = replies.data?.replies;

  return (
    <section aria-labelledby="replies-h" className="grid gap-4">
      <div>
        <h2 id="replies-h" className="font-display text-display-sm font-bold">
          Saved replies
        </h2>
        <p className="mt-1 text-[15px] text-muted">
          Answers you give often, ready in the inbox: type <kbd className="font-bold">/</kbd> in the
          reply box, or tap ⚡. Everyone on the team can use and change them.
        </p>
      </div>
      {list && list.length > 0 && (
        <ul className="divide-y-2 divide-line border-2 border-edge bg-surface shadow-hard">
          {list.map((r) =>
            editing === r.id ? (
              <li key={r.id} className="p-3">
                <ReplyForm
                  reply={r}
                  onDone={async () => {
                    setEditing(undefined);
                    await replies.reload();
                  }}
                  onCancel={() => setEditing(undefined)}
                />
              </li>
            ) : (
              <li key={r.id} className="grid gap-1 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-bold">{r.title}</span>
                  <button
                    type="button"
                    className="linkbtn min-h-10"
                    onClick={() => setEditing(r.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="linkbtn min-h-10 text-danger"
                    onClick={async () => {
                      if (!confirm(`Delete the saved reply "${r.title}"?`)) return;
                      await api(`/saved-replies/${r.id}`, undefined, 'DELETE');
                      await replies.reload();
                    }}
                  >
                    Delete
                  </button>
                </div>
                <p className="line-clamp-3 text-[14px] whitespace-pre-line text-muted">{r.text}</p>
              </li>
            ),
          )}
        </ul>
      )}
      {list?.length === 0 && (
        <p className="text-muted">
          No saved replies yet. Add one below, or save one from the reply box in a conversation.
        </p>
      )}
      <div className="card card-flat grid gap-3">
        <h3 className="font-bold">Add a saved reply</h3>
        <ReplyForm onDone={replies.reload} />
      </div>
    </section>
  );
}

/** A new saved reply, or changes to one. */
export function ReplyForm({
  reply,
  text: initialText,
  onDone,
  onCancel,
}: {
  reply?: SavedReply;
  /** Starts a new one with this text (from the reply box). */
  text?: string;
  onDone: () => unknown;
  onCancel?: () => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError(undefined);
    try {
      if (reply) await api(`/saved-replies/${reply.id}`, body, 'PUT');
      else {
        await api('/saved-replies', body);
        form.reset();
      }
      await onDone();
    } catch (err) {
      setError(errorText(err, 'Couldn’t save it.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3">
      <Field
        label="Name"
        name="title"
        required
        maxLength={60}
        defaultValue={reply?.title}
        placeholder="Pricing"
        hint="What you’ll type after / to find it."
      />
      <label className="grid gap-1.5">
        <span className="text-sm font-bold">Reply</span>
        <textarea
          className="input min-h-28"
          name="text"
          required
          maxLength={1000}
          defaultValue={reply?.text ?? initialText}
          placeholder="Hi {{first_name | there}}! Our prices are…"
        />
        <span className="text-[13px] text-muted">
          {'{{first_name | there}}'} becomes their first name, or “there” if we don’t know it. Any
          contact field works the same way.
        </span>
      </label>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {reply ? 'Save changes' : 'Add saved reply'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
