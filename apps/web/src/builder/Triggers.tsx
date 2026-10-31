import type { TriggerConfig } from '@social-switchboard/flow';
import { type FormEvent, useState } from 'react';
import { ApiError, api, type Trigger } from '../api';
import { Field, FormError, Select, Toggle } from '../ui';

export function triggerText(c: TriggerConfig): string {
  switch (c.type) {
    case 'keyword':
      return `${c.keywords.join(', ')}${c.match === 'exact' ? '' : c.match === 'contains' ? ' (anywhere)' : ' (starts with)'}`;
    case 'welcome':
      return 'New contact’s first message';
    case 'default_reply':
      return 'Anything else (default reply)';
    case 'ref':
      return `Link ref=${c.ref}`;
  }
}

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

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    let config: TriggerConfig;
    if (type === 'keyword') {
      const keywords = String(form.get('keywords') ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      config = { type, keywords, match: form.get('match') as 'exact' | 'contains' | 'starts_with' };
    } else if (type === 'ref') config = { type, ref: String(form.get('ref') ?? '').trim() };
    else config = { type };
    setError(undefined);
    try {
      await api('/triggers', { flowId, config });
      e.currentTarget?.reset();
      onChange();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_input'
          ? 'Check the keyword or ref (letters, numbers, _ and - for refs).'
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
              <p className="truncate font-bold">{triggerText(t.config)}</p>
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
          <option value="keyword">Keyword in a message</option>
          <option value="welcome">New contact’s first message</option>
          <option value="default_reply">Default reply (nothing else matched)</option>
          <option value="ref">Entry link with a ref</option>
        </Select>
        {type === 'keyword' && (
          <>
            <Field
              label="Keywords"
              name="keywords"
              required
              placeholder="WORKSHOP, workshop info"
              hint="Separate several with commas. Case and punctuation don’t matter."
            />
            <Select label="Match" name="match" defaultValue="exact">
              <option value="exact">The whole message</option>
              <option value="contains">Anywhere, as a whole word</option>
              <option value="starts_with">The start of the message</option>
            </Select>
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
