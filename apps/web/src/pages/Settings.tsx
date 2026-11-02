import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, api, type FieldDef, type Me, type Tag, useApi } from '../api';
import { SquareIcon, type SquareIconName } from '../components/SquareIcons';
import { getTheme, setTheme, type ThemeChoice } from '../theme';
import { Field, FormError, PageHeader, Select } from '../ui';
import { AiSection } from './AiSettings';
import { NotificationsSection } from './NotificationSettings';
import { RepliesSection } from './SavedReplies';
import { Page } from './Shell';
import { TeamSection } from './TeamSettings';

// Settings, one section at a time: on phones a menu that opens each section like a settings app;
// from 900px the menu sits beside the open section.

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Match my device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

type SectionId = 'general' | 'team' | 'notifications' | 'replies' | 'ai' | 'data';
const SECTIONS: { id: SectionId; label: string; detail: string; icon: SquareIconName }[] = [
  { id: 'general', label: 'Appearance & account', detail: 'Theme, your sign-in', icon: 'sliders' },
  { id: 'team', label: 'Team', detail: 'Teammates, roles, invites', icon: 'kit' },
  {
    id: 'notifications',
    label: 'Notifications',
    detail: 'This phone, email, texts',
    icon: 'inbox',
  },
  {
    id: 'replies',
    label: 'Saved replies',
    detail: 'What you often say in the inbox',
    icon: 'chat',
  },
  { id: 'ai', label: 'AI', detail: 'Anthropic or OpenAI key, model', icon: 'sparkle' },
  { id: 'data', label: 'Fields & tags', detail: 'What you save about contacts', icon: 'board' },
];
/** Old links pointed at headings on one long page (#ai-h): they open that section. */
const OLD_ANCHORS: Record<string, SectionId> = {
  'look-h': 'general',
  'account-h': 'general',
  'team-h': 'team',
  'notify-h': 'notifications',
  'notifications-h': 'notifications',
  'ai-h': 'ai',
  'fields-h': 'data',
  'tags-h': 'data',
};

export function Settings({ me }: { me: Me }) {
  const { section } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const anchor = OLD_ANCHORS[location.hash.slice(1)];
  useEffect(() => {
    if (anchor) navigate(`/settings/${anchor}`, { replace: true });
  }, [anchor, navigate]);

  const current = SECTIONS.find((s) => s.id === section);
  const body: Record<SectionId, ReactNode> = {
    general: <GeneralSection me={me} />,
    team: <TeamSection me={me} />,
    notifications: <NotificationsSection me={me} />,
    replies: <RepliesSection />,
    ai: <AiSection me={me} />,
    data: <DataSection />,
  };

  return (
    <Page>
      {/* Phones: the menu on its own, or one section with a way back. */}
      <div className="grid gap-5 min-[900px]:hidden">
        {current ? (
          <>
            <Link to="/settings" className="linkbtn -mb-2 w-fit">
              ← Settings
            </Link>
            {body[current.id]}
          </>
        ) : (
          <>
            <PageHeader title="Settings" />
            <SectionMenu />
          </>
        )}
      </div>

      {/* From 900px: the menu beside the open section. */}
      <div className="hidden min-[900px]:grid min-[900px]:gap-6">
        <PageHeader title="Settings" />
        <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-8">
          <div className="sticky top-6">
            <SectionMenu selected={current?.id ?? 'general'} />
          </div>
          <div className="grid gap-6">{body[current?.id ?? 'general']}</div>
        </div>
      </div>
    </Page>
  );
}

function SectionMenu({ selected }: { selected?: SectionId }) {
  return (
    <nav
      aria-label="Settings"
      className="grid divide-y-2 divide-line border-2 border-edge bg-surface"
    >
      {SECTIONS.map((s) => (
        <NavLink
          key={s.id}
          to={`/settings/${s.id}`}
          aria-current={selected === s.id ? 'page' : undefined}
          className="sheet-row border-0"
        >
          <SquareIcon name={s.icon} />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="font-bold">{s.label}</span>
            <span className="text-[13px] font-normal text-muted">{s.detail}</span>
          </span>
          <span className="text-muted min-[900px]:hidden" aria-hidden>
            ›
          </span>
        </NavLink>
      ))}
    </nav>
  );
}

function GeneralSection({ me }: { me: Me }) {
  const [theme, setChoice] = useState(getTheme());
  return (
    <>
      <section aria-labelledby="look-h" className="grid gap-4">
        <h2 id="look-h" className="font-display text-display-sm font-bold">
          Appearance
        </h2>
        <fieldset className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:gap-3">
          <legend className="sr-only">Theme</legend>
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={theme === t.value}
              className={`btn px-2 sm:px-5 ${theme === t.value ? 'bg-surface-2 shadow-hard' : ''}`}
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
    </>
  );
}

function DataSection() {
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
    <>
      <section aria-labelledby="fields-h" className="grid gap-4">
        <div>
          <h2 id="fields-h" className="font-display text-display-sm font-bold">
            Contact fields
          </h2>
          <p className="mt-1 text-[15px] text-muted">
            Details you save about each person, like an interest or a budget. Automations fill them
            in (an <b>Ask</b> step saves the answer, an <b>AI conversation</b> picks them out of the
            chat), and messages can use them, like <code>{'{{first_name}}'}</code>. First name, last
            name, email and phone are built in.
          </p>
        </div>
        <ul className="divide-y-2 divide-line border-2 border-edge bg-surface shadow-hard">
          {fields.data?.fields.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <span className="min-w-0 flex-1 font-bold">{f.label}</span>
              <code className="text-[13px]">{`{{${f.key}}}`}</code>
              <span className="text-[13px] text-muted capitalize">{f.type}</span>
              <button
                type="button"
                className="linkbtn min-h-10 text-danger"
                onClick={async () => {
                  if (!confirm(`Delete "${f.label}"? Its value is removed from every contact.`))
                    return;
                  await api(`/fields/${f.id}`, undefined, 'DELETE');
                  void fields.reload();
                }}
              >
                Delete
              </button>
            </li>
          ))}
          {fields.data?.fields.length === 0 && (
            <li className="px-4 py-4 text-muted">
              No custom fields yet. Automations create them automatically when they save an answer.
            </li>
          )}
        </ul>
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
            title="Lowercase letters, numbers and _, starting with a letter."
          />
          <Select label="Type" name="type" defaultValue="text">
            {['text', 'number', 'date', 'email', 'phone', 'url', 'choice'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <button type="submit" className="btn btn-primary">
            Add field
          </button>
          <p className="text-[13px] text-muted sm:col-span-4">
            The key is how automations use it, like <code>{'{{budget}}'}</code>: lowercase letters,
            numbers and _.
          </p>
          <div className="empty:hidden sm:col-span-4">
            <FormError message={fieldError} />
          </div>
        </form>
      </section>

      <section aria-labelledby="tags-h" className="grid gap-4">
        <div>
          <h2 id="tags-h" className="font-display text-display-sm font-bold">
            Tags
          </h2>
          <p className="mt-1 text-[15px] text-muted">
            Short labels you put on people to sort them into groups, like <i>vip</i>,{' '}
            <i>workshop-lead</i> or <i>guide-sent</i>. A person can have any number of them.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Explainer title="How people get tagged">
            <li>
              <b>By an automation</b>, automatically: an <b>Actions</b> step with “Add a tag”. For
              example, tag everyone who asks for your guide.
            </li>
            <li>
              <b>By hand</b>: <b>+ Tag</b> on a conversation in the Inbox, or on a person’s page in
              Contacts.
            </li>
          </Explainer>
          <Explainer title="What tags are for">
            <li>
              <b>Finding people</b>: filter the Inbox or Contacts to everyone with a tag.
            </li>
            <li>
              <b>Steering automations</b>: a <b>Condition</b> step can check for a tag, so someone
              who already got the guide isn’t sent it twice.
            </li>
          </Explainer>
        </div>

        <div className="grid gap-2">
          <h3 className="font-bold">Your tags</h3>
          <div className="flex flex-wrap gap-2">
            {tags.data?.tags.map((t) => (
              <span key={t.id} className="chip gap-2 py-1 text-[12px]">
                <Link
                  to={`/contacts?tag=${encodeURIComponent(t.name)}`}
                  className="text-ink no-underline hover:underline"
                  title={`See who’s tagged ${t.name}`}
                >
                  {t.name}{' '}
                  <span className="text-muted tabular-nums">
                    · {t.contacts} {t.contacts === 1 ? 'person' : 'people'}
                  </span>
                </Link>
                <button
                  type="button"
                  aria-label={`Delete tag ${t.name}`}
                  className="-my-2 -mr-1 px-1.5 py-2 font-bold hover:text-danger"
                  onClick={async () => {
                    if (
                      !confirm(
                        `Delete the tag "${t.name}"? It’s removed from ${t.contacts} ${t.contacts === 1 ? 'person' : 'people'}.`,
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
              <p className="text-muted">
                None yet. Tags show up here as your automations and your team add them.
              </p>
            )}
          </div>
          {Boolean(tags.data?.tags.length) && (
            <p className="text-[13px] text-muted">Tap a tag to see who has it.</p>
          )}
        </div>
        <form onSubmit={addTag} className="grid max-w-md gap-1.5">
          <div className="flex items-end gap-3">
            <Field label="New tag" name="name" required className="flex-1" placeholder="vip" />
            <button type="submit" className="btn">
              Add
            </button>
          </div>
          <p className="text-[13px] text-muted">
            Rarely needed: automations and the Inbox create tags as they use them. Adding one here
            just has it ready to pick.
          </p>
          <FormError message={tagError} />
        </form>
      </section>
    </>
  );
}

/** A small "how this works" box: a title and a few points. */
function Explainer({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2 border-2 border-line bg-surface p-4">
      <h3 className="text-[15px] font-bold">{title}</h3>
      <ul className="grid list-disc gap-1.5 pl-5 text-[14px]">{children}</ul>
    </div>
  );
}
