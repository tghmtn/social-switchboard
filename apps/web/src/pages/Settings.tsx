import { type FormEvent, useState } from 'react';
import { ApiError, api, type FieldDef, type Me, type Tag, useApi } from '../api';
import { getTheme, setTheme, type ThemeChoice } from '../theme';
import { Field, FormError, PageHeader, Select } from '../ui';
import { AiSection } from './AiSettings';
import { Page } from './Shell';
import { NotificationsSection, TeamSection } from './TeamSettings';

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Match my device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function Settings({ me }: { me: Me }) {
  const [theme, setChoice] = useState(getTheme());
  const fields = useApi<{ fields: FieldDef[] }>('/fields');
  const tags = useApi<{ tags: Tag[] }>('/tags');
  const [fieldError, setFieldError] = useState<string>();
  const [tagError, setTagError] = useState<string>();

  async function addField(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setFieldError(undefined);
    try {
      await api('/fields', Object.fromEntries(new FormData(form)));
      form.reset();
      void fields.reload();
    } catch (err) {
      const first =
        err instanceof ApiError
          ? (Object.values(err.fieldErrors())[0] ?? err.code)
          : 'Couldn’t add the field.';
      setFieldError(first);
    }
  }

  async function addTag(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setTagError(undefined);
    try {
      await api('/tags', Object.fromEntries(new FormData(form)));
      form.reset();
      void tags.reload();
    } catch (err) {
      setTagError(
        err instanceof ApiError && err.status === 409
          ? 'That tag already exists.'
          : 'Couldn’t add the tag.',
      );
    }
  }

  return (
    <Page>
      <PageHeader title="Settings" />

      <section aria-labelledby="look-h" className="grid gap-4">
        <h2 id="look-h" className="font-display text-display-sm font-bold">
          Appearance
        </h2>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="sr-only">Theme</legend>
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={theme === t.value}
              className={`btn ${theme === t.value ? 'bg-surface-2 shadow-hard' : ''}`}
              onClick={() => {
                setTheme(t.value);
                setChoice(t.value);
              }}
            >
              {t.label}
            </button>
          ))}
        </fieldset>
      </section>

      <section aria-labelledby="account-h" className="grid gap-4">
        <h2 id="account-h" className="font-display text-display-sm font-bold">
          Account
        </h2>
        <dl className="card divide-y-2 divide-line p-0">
          {[
            ['Name', me.user.name],
            ['Email', me.user.email],
            ...me.workspaces.map((w) => ['Workspace', `${w.name} (${w.role})`]),
          ].map(([k, v]) => (
            <div key={`${k}${v}`} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:gap-4">
              <dt className="w-32 shrink-0 text-label uppercase text-muted sm:pt-1">{k}</dt>
              <dd className="font-bold break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <TeamSection me={me} />
      <NotificationsSection me={me} />
      <AiSection me={me} />

      <section aria-labelledby="fields-h" className="grid gap-4">
        <div>
          <h2 id="fields-h" className="font-display text-display-sm font-bold">
            Contact fields
          </h2>
          <p className="mt-1 text-[15px] text-muted">
            Extra details you collect in flows, like an interest or a budget. First name, last name,
            email and phone are built in.
          </p>
        </div>
        <div className="overflow-x-auto border-2 border-edge bg-surface shadow-hard">
          <table className="w-full min-w-[520px] text-left text-[15px]">
            <thead className="bg-surface-2 text-label uppercase text-muted">
              <tr>
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Key (use in messages)</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-line">
              {fields.data?.fields.map((f) => (
                <tr key={f.id}>
                  <td className="px-4 py-3 font-bold">{f.label}</td>
                  <td className="px-4 py-3">
                    <code className="text-[13px]">{`{{${f.key}}}`}</code>
                  </td>
                  <td className="px-4 py-3 capitalize">{f.type}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      className="linkbtn text-danger"
                      onClick={async () => {
                        if (
                          !confirm(`Delete "${f.label}"? Its value is removed from every contact.`)
                        )
                          return;
                        await api(`/fields/${f.id}`, undefined, 'DELETE');
                        void fields.reload();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {fields.data?.fields.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-muted">
                    No custom fields yet. Flows create them automatically when they save an answer.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <form
          onSubmit={addField}
          className="card card-flat grid items-end gap-3 sm:grid-cols-[1fr_1fr_160px_auto]"
        >
          <Field label="Label" name="label" required placeholder="Budget" />
          <Field
            label="Key"
            name="key"
            required
            placeholder="budget"
            pattern="[a-z][a-z0-9_]*"
            hint="lowercase, numbers, _"
          />
          <Select label="Type" name="type" defaultValue="text">
            {['text', 'number', 'date', 'email', 'phone', 'url', 'choice'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <button type="submit" className="btn btn-primary mb-[22px] sm:mb-[22px]">
            Add field
          </button>
          <div className="sm:col-span-4">
            <FormError message={fieldError} />
          </div>
        </form>
      </section>

      <section aria-labelledby="tags-h" className="grid gap-4">
        <h2 id="tags-h" className="font-display text-display-sm font-bold">
          Tags
        </h2>
        <div className="flex flex-wrap gap-2">
          {tags.data?.tags.map((t) => (
            <span key={t.id} className="chip gap-2 py-1 text-[12px]">
              {t.name} <span className="tabular-nums text-muted">{t.contacts}</span>
              <button
                type="button"
                aria-label={`Delete tag ${t.name}`}
                className="font-bold hover:text-danger"
                onClick={async () => {
                  if (
                    !confirm(
                      `Delete the tag "${t.name}"? It’s removed from ${t.contacts} contact(s).`,
                    )
                  )
                    return;
                  await api(`/tags/${t.id}`, undefined, 'DELETE');
                  void tags.reload();
                }}
              >
                ×
              </button>
            </span>
          ))}
          {tags.data?.tags.length === 0 && (
            <p className="text-muted">No tags yet. Flows add them as people move through.</p>
          )}
        </div>
        <form onSubmit={addTag} className="flex max-w-md items-end gap-3">
          <Field label="New tag" name="name" required className="flex-1" placeholder="vip" />
          <button type="submit" className="btn">
            Add
          </button>
        </form>
        <FormError message={tagError} />
      </section>
    </Page>
  );
}
