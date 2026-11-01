import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, avatarUrl, type ContactDetail as Detail, useApi } from '../api';
import { Avatar, Field, FormError, Toggle, timeAgo } from '../ui';
import { contactName } from './Contacts';
import { Page } from './Shell';

/** "Sat 9:41 AM": when a pause ends. */
const untilText = (at: string) =>
  new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** What the channel told us about them: "Follows you · 1,204 followers". */
function profileFacts(i: Detail['identities'][number]) {
  const facts = [
    i.followsUs === true ? 'Follows you' : i.followsUs === false ? 'Doesn’t follow you' : null,
    i.weFollow ? 'You follow them' : null,
    i.followerCount !== null ? `${i.followerCount.toLocaleString()} followers` : null,
  ].filter(Boolean);
  return facts.join(' · ');
}

const RUN_CHIP: Record<string, string> = {
  waiting: 'chip-orange',
  completed: 'chip-success',
  failed: 'chip-danger',
};

function eventText(e: Detail['events'][number], flowNames: Map<string, string>): string {
  const d = e.data as Record<string, string | boolean | null | undefined>;
  const flow = (d.flowId && flowNames.get(String(d.flowId))) || 'a flow';
  switch (e.type) {
    case 'contact_created':
      return `First message, on ${d.channel}`;
    case 'flow_started':
      return `Started “${flow}”`;
    case 'flow_completed':
      return `Finished “${flow}”`;
    case 'flow_failed':
      return `“${flow}” stopped: ${d.error ?? 'error'}`;
    case 'flow_expired':
      return `“${flow}” timed out waiting for a reply`;
    case 'tag_added':
      return `Tagged “${d.tag}”`;
    case 'tag_removed':
      return `Tag “${d.tag}” removed`;
    case 'field_set':
      return d.value === null ? `Cleared ${d.key}` : `${d.key} set to “${d.value}”`;
    case 'consent_changed':
      return `${d.channel === 'sms' ? 'SMS' : 'Email'} consent ${d.granted ? 'given' : 'withdrawn'}`;
    case 'team_notified':
      return `Team notified: ${d.message}`;
    case 'handoff':
      return `Handed off to a person${d.note ? ` (${d.note})` : ''}`;
    case 'person_replied':
      return 'You replied from Instagram, so automation paused';
    case 'automation_resumed':
      return d.automatic
        ? 'Automation back on (12 hours after your last reply)'
        : 'Automation resumed';
    case 'contact_edited':
      return 'Details edited';
    default:
      return e.type.replace(/_/g, ' ');
  }
}

export function ContactDetail() {
  const { id = '' } = useParams();
  const { data, error, reload } = useApi<Detail>(`/contacts/${id}`);
  const navigate = useNavigate();
  const [saveError, setSaveError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [newTag, setNewTag] = useState('');

  if (error)
    return (
      <Page>
        <p className="font-bold text-danger">This contact doesn’t exist (or was deleted).</p>
      </Page>
    );
  if (!data) return null;
  const c = data.contact;
  const flowNames = new Map(data.runs.map((r) => [r.flowId, r.flowName]));
  const consent = (channel: string) =>
    data.consents.find((x) => x.channel === channel)?.granted ?? false;

  async function saveDetails(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fields: Record<string, string | number | null> = {};
    for (const f of c.fields) {
      const raw = String(form.get(`field:${f.key}`) ?? '').trim();
      fields[f.key] =
        raw === '' ? null : f.type === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
    setSaveError(undefined);
    try {
      await api(
        `/contacts/${id}`,
        {
          firstName: String(form.get('firstName') ?? ''),
          lastName: String(form.get('lastName') ?? ''),
          email: String(form.get('email') ?? ''),
          phone: String(form.get('phone') ?? ''),
          fields,
        },
        'PATCH',
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void reload();
    } catch {
      setSaveError('Couldn’t save. Check the email address format.');
    }
  }

  return (
    <Page>
      <Link to="/contacts" className="linkbtn w-fit">
        ← Contacts
      </Link>
      <div className="-mt-3 flex flex-wrap items-center gap-x-4 gap-y-3 sm:-mt-4">
        <Avatar name={contactName(c)} size={56} src={avatarUrl(c)} />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <h1 className="font-display text-[1.75rem] leading-tight font-extrabold break-words sm:text-display-lg">
            {contactName(c)}
          </h1>
          <div className="flex flex-wrap gap-2">
            {data.identities.map((i) => (
              <span key={`${i.channel}${i.externalId}`} className="chip max-w-full truncate">
                {i.channel}
                {i.username ? ` @${i.username}` : ''}
                {i.verified ? ' ✓' : ''}
              </span>
            ))}
            {data.identities
              .map((i) => profileFacts(i))
              .filter(Boolean)
              .map((facts) => (
                <span key={facts} className="text-[13px] text-muted">
                  {facts}
                </span>
              ))}
            <span className="text-[13px] text-muted">Last seen {timeAgo(c.lastSeenAt)}</span>
          </div>
        </div>
        {data.identities.some((i) => i.channel !== 'simulator') && (
          <Link to={`/inbox/${c.id}`} className="btn btn-sm w-full sm:w-auto">
            Open in Inbox
          </Link>
        )}
      </div>

      {c.automationPausedAt && (
        <div className="card flex flex-wrap items-center gap-3 border-accent">
          <span className="chip chip-orange">
            {c.automationResumeAt ? 'You replied' : 'Needs a person'}
          </span>
          {c.automationResumeAt ? (
            <p className="flex-1 text-[15px]">
              You replied from Instagram {timeAgo(c.automationPausedAt)}, so flows won’t answer them
              until {untilText(c.automationResumeAt)}. Each reply you send restarts the 12 hours.
            </p>
          ) : (
            <p className="flex-1 text-[15px]">
              A flow handed this conversation off {timeAgo(c.automationPausedAt)}. Automation is
              paused until you resume it.
            </p>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              await api(`/contacts/${id}/resume-automation`, {});
              void reload();
            }}
          >
            Resume automation
          </button>
        </div>
      )}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid gap-8">
          <form onSubmit={saveDetails} className="card grid gap-4">
            <h2 className="font-display text-display-sm font-bold">Details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" name="firstName" defaultValue={c.firstName ?? ''} />
              <Field label="Last name" name="lastName" defaultValue={c.lastName ?? ''} />
              <Field label="Email" name="email" type="email" defaultValue={c.email ?? ''} />
              <Field label="Phone" name="phone" type="tel" defaultValue={c.phone ?? ''} />
              {c.fields.map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  name={`field:${f.key}`}
                  defaultValue={f.value === null ? '' : String(f.value)}
                  hint={`{{${f.key}}}`}
                />
              ))}
            </div>
            <FormError message={saveError} />
            <div className="flex items-center gap-3">
              <button type="submit" className="btn btn-primary">
                Save details
              </button>
              {saved && <span className="text-[13px] font-bold text-success">Saved</span>}
            </div>
          </form>

          <section aria-labelledby="timeline-h" className="grid gap-4">
            <h2 id="timeline-h" className="font-display text-display-sm font-bold">
              Timeline
            </h2>
            <ol className="card divide-y-2 divide-line p-0">
              {data.events.map((e) => (
                <li
                  key={e.id}
                  className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-[15px]"
                >
                  <span className="min-w-0 break-words">{eventText(e, flowNames)}</span>
                  <time className="shrink-0 text-[13px] text-muted" dateTime={e.at}>
                    {timeAgo(e.at)}
                  </time>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="grid gap-6">
          <section className="card grid gap-3" aria-labelledby="tags-h">
            <h2 id="tags-h" className="text-lg font-bold">
              Tags
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {c.tags.length === 0 && <span className="text-[13px] text-muted">No tags</span>}
              {c.tags.map((t) => (
                <span key={t} className="chip chip-lime gap-2">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove tag ${t}`}
                    className="font-bold"
                    onClick={async () => {
                      await api(
                        `/contacts/${id}/tags/${encodeURIComponent(t)}`,
                        undefined,
                        'DELETE',
                      );
                      void reload();
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newTag.trim()) return;
                await api(`/contacts/${id}/tags`, { tag: newTag.trim() });
                setNewTag('');
                void reload();
              }}
            >
              <label htmlFor="add-tag" className="sr-only">
                Add a tag
              </label>
              <input
                id="add-tag"
                className="input"
                placeholder="Add a tag"
                value={newTag}
                maxLength={50}
                onChange={(e) => setNewTag(e.target.value)}
              />
              <button type="submit" className="btn btn-sm">
                Add
              </button>
            </form>
          </section>

          <section className="card grid gap-3" aria-labelledby="consent-h">
            <h2 id="consent-h" className="text-lg font-bold">
              Consent
            </h2>
            {(['email', 'sms'] as const).map((channel) => (
              <div key={channel} className="flex items-center justify-between gap-3">
                <span className="text-[15px]">
                  {channel === 'email' ? 'Email follow-ups' : 'SMS follow-ups'}
                </span>
                <Toggle
                  on={consent(channel)}
                  label={`${channel} consent`}
                  onChange={async (granted) => {
                    await api(`/contacts/${id}/consent`, { channel, granted });
                    void reload();
                  }}
                />
              </div>
            ))}
            <p className="text-[13px] text-muted">
              Recorded with the date and where it came from. Only send follow-ups to people who
              opted in.
            </p>
          </section>

          <section className="card grid gap-2" aria-labelledby="runs-h">
            <h2 id="runs-h" className="text-lg font-bold">
              Flows
            </h2>
            {data.runs.length === 0 && (
              <p className="text-[13px] text-muted">No flows have run yet.</p>
            )}
            {data.runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-[14px]">
                <Link to={`/flows/${r.flowId}`} className="truncate font-bold">
                  {r.flowName}
                </Link>
                <span className={`chip ${RUN_CHIP[r.status] ?? ''}`}>{r.status}</span>
              </div>
            ))}
          </section>

          <button
            type="button"
            className="btn w-fit border-danger text-danger"
            onClick={async () => {
              if (
                !confirm(
                  `Permanently delete ${contactName(c)}? Their messages, tags, fields and history are erased. This can’t be undone.`,
                )
              )
                return;
              await api(`/contacts/${id}`, undefined, 'DELETE');
              navigate('/contacts');
            }}
          >
            Delete contact
          </button>
        </div>
      </div>
    </Page>
  );
}
