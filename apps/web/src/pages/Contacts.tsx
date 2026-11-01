import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { avatarUrl, type ContactRow, type Tag, useApi } from '../api';
import { Avatar, EmptyState, PageHeader, timeAgo } from '../ui';
import { Page } from './Shell';

export const contactName = (c: {
  firstName: string | null;
  lastName: string | null;
  username?: string | null;
  email?: string | null;
}) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ') ||
  (c.username ? `@${c.username}` : c.email) ||
  'Unnamed contact';

const PAGE = 50;

export function Contacts() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  const [search, setSearch] = useState(q);
  const tags = useApi<{ tags: Tag[] }>('/tags');
  const query = new URLSearchParams({
    ...(q && { q }),
    ...(tag && { tag }),
    limit: String(PAGE),
    offset: String(offset),
  });
  const { data, loading } = useApi<{ contacts: ContactRow[]; total: number }>(`/contacts?${query}`);

  // Search as you type, but only after a short pause.
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(
      () =>
        setParams((p) => {
          const next = new URLSearchParams(p);
          if (search) next.set('q', search);
          else next.delete('q');
          next.delete('offset');
          return next;
        }),
      300,
    );
    return () => clearTimeout(t);
  }, [search, q, setParams]);

  const setTag = (value: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set('tag', value);
      else next.delete('tag');
      next.delete('offset');
      return next;
    });

  const total = data?.total ?? 0;
  const filtered = Boolean(q || tag);

  return (
    <Page>
      <PageHeader
        title="Contacts"
        eyebrow={data ? `${total} ${total === 1 ? 'person' : 'people'}` : undefined}
        actions={
          <a
            className="btn btn-sm sm:min-h-0 sm:px-5 sm:py-3"
            href="/api/contacts/export.csv"
            download
          >
            Export CSV
          </a>
        }
      />

      <div className="flex flex-wrap gap-3">
        <div className="w-full min-w-0 sm:min-w-[220px] sm:flex-1">
          <label htmlFor="contact-search" className="sr-only">
            Search contacts
          </label>
          <input
            id="contact-search"
            className="input"
            type="search"
            placeholder="Search name, email, phone or @username"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-56">
          <label htmlFor="contact-tag" className="sr-only">
            Filter by tag
          </label>
          <select
            id="contact-tag"
            className="input"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="">All tags</option>
            {tags.data?.tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name} ({t.contacts})
              </option>
            ))}
          </select>
        </div>
      </div>

      {!loading && total === 0 ? (
        filtered ? (
          <p className="text-muted">No contacts match.</p>
        ) : (
          <EmptyState
            icon="kit"
            title="No contacts yet"
            body={
              <>
                People appear here the first time they message you. Try it now in the{' '}
                <Link to="/simulator">simulator</Link>.
              </>
            }
          />
        )
      ) : (
        <>
          {/* Phones: one row per person, everything that matters at a glance. */}
          <ul className="divide-y-2 divide-line border-2 border-edge bg-surface md:hidden">
            {data?.contacts.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/contacts/${c.id}`}
                  className="flex items-center gap-3 px-3 py-3 text-ink no-underline active:bg-surface-2"
                >
                  <Avatar name={contactName(c)} size={44} src={avatarUrl(c)} />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-bold">{contactName(c)}</span>
                      <span className="ml-auto shrink-0 text-[12px] text-muted">
                        {timeAgo(c.lastSeenAt)}
                      </span>
                    </span>
                    <span className="truncate text-[13px] text-muted">
                      {[c.username && `@${c.username}`, c.email, c.channels.join(', ')]
                        .filter(Boolean)
                        .join(' · ') || 'No details yet'}
                    </span>
                    {(c.tags.length > 0 || c.automationPausedAt) && (
                      <span className="flex flex-wrap gap-1 pt-0.5">
                        {c.automationPausedAt && (
                          <span className="chip chip-orange px-1.5 py-0">
                            {c.automationResumeAt ? 'You replied' : 'Needs a person'}
                          </span>
                        )}
                        {c.tags.slice(0, 3).map((t) => (
                          <span key={t} className="chip px-1.5 py-0">
                            {t}
                          </span>
                        ))}
                        {c.tags.length > 3 && (
                          <span className="text-[12px] text-muted">+{c.tags.length - 3}</span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="text-muted" aria-hidden>
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto border-2 border-edge bg-surface shadow-hard md:block">
            <table className="w-full min-w-[680px] text-left text-[15px]">
              <thead className="bg-surface-2 text-label uppercase text-muted">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Tags</th>
                  <th className="px-4 py-3">Channels</th>
                  <th className="px-4 py-3 text-right">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-line">
                {data?.contacts.map((c) => (
                  <tr key={c.id} className="hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <Link
                        to={`/contacts/${c.id}`}
                        className="flex items-center gap-3 font-bold text-ink no-underline hover:underline"
                      >
                        <Avatar name={contactName(c)} size={32} src={avatarUrl(c)} />
                        <span className="truncate">{contactName(c)}</span>
                        {c.automationPausedAt && (
                          <span className="chip chip-orange">
                            {c.automationResumeAt ? 'You replied' : 'Needs a person'}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{c.email ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 3).map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                        {c.tags.length > 3 && (
                          <span className="text-[13px] text-muted">+{c.tags.length - 3}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[13px] capitalize">{c.channels.join(', ')}</td>
                    <td className="px-4 py-3 text-right text-[13px] text-muted">
                      {timeAgo(c.lastSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {total > PAGE && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="btn btn-sm"
            disabled={offset === 0}
            onClick={() =>
              setParams((p) => {
                const n = new URLSearchParams(p);
                n.set('offset', String(Math.max(0, offset - PAGE)));
                return n;
              })
            }
          >
            ← Previous
          </button>
          <span className="text-[13px] text-muted tabular-nums">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={offset + PAGE >= total}
            onClick={() =>
              setParams((p) => {
                const n = new URLSearchParams(p);
                n.set('offset', String(offset + PAGE));
                return n;
              })
            }
          >
            Next →
          </button>
        </div>
      )}
    </Page>
  );
}
