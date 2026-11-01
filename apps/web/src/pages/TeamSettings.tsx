import { type FormEvent, useState } from 'react';
import { ApiError, api, type Me, useApi } from '../api';
import { Field, FormError, Select } from '../ui';

// Settings for owners and admins: who's on the team (members, roles, invite links).

type Team = {
  members: {
    userId: string;
    firstName: string;
    lastName: string;
    email: string;
    role: 'owner' | 'admin' | 'agent';
  }[];
  invites: { id: string; email: string; role: string; expiresAt: string }[];
};

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including roles.',
  admin: 'Everything except roles: channels, notifications, invites.',
  agent: 'The inbox, contacts and flows. No channel or team settings.',
};

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? (Object.values(err.fieldErrors())[0] ?? (err.code.includes(' ') ? err.code : fallback))
    : fallback;

export function TeamSection({ me }: { me: Me }) {
  const team = useApi<Team>('/team');
  const role = me.workspaces[0]?.role;
  const canInvite = role === 'owner' || role === 'admin';
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setError(undefined);
    try {
      const r = await api<Team & { link: string }>(
        '/team/invites',
        Object.fromEntries(new FormData(form)),
      );
      setLink(r.link);
      team.setData(r);
      form.reset();
    } catch (err) {
      setError(errorText(err, 'Couldn’t make the invite.'));
    }
  }

  return (
    <section aria-labelledby="team-h" className="grid gap-4">
      <div>
        <h2 id="team-h" className="font-display text-display-sm font-bold">
          Team
        </h2>
        <p className="mt-1 text-[15px] text-muted">
          Everyone shares the inbox. Free for any number of people.
        </p>
      </div>
      <ul className="card divide-y-2 divide-line p-0">
        {team.data?.members.map((m) => {
          const name = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email;
          const you = m.userId === me.user.id;
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-bold">
                  {name}
                  {you && <span className="text-muted"> (you)</span>}
                </p>
                <p className="text-[13px] text-muted">{m.email}</p>
              </div>
              {role === 'owner' ? (
                <select
                  className="input w-auto py-1 text-[13px]"
                  aria-label={`Role for ${name}`}
                  value={m.role}
                  onChange={async (e) => {
                    try {
                      team.setData(
                        await api<Team>(
                          `/team/members/${m.userId}`,
                          { role: e.target.value },
                          'PATCH',
                        ),
                      );
                    } catch (err) {
                      setError(errorText(err, 'Couldn’t change the role.'));
                    }
                  }}
                >
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="agent">Agent</option>
                </select>
              ) : (
                <span className="chip capitalize">{m.role}</span>
              )}
              {(canInvite || you) && (
                <button
                  type="button"
                  className="linkbtn text-[13px] text-danger"
                  onClick={async () => {
                    if (!confirm(you ? 'Leave this workspace?' : `Remove ${name} from the team?`))
                      return;
                    try {
                      team.setData(
                        await api<Team>(`/team/members/${m.userId}`, undefined, 'DELETE'),
                      );
                    } catch (err) {
                      setError(errorText(err, 'Couldn’t remove them.'));
                    }
                  }}
                >
                  {you ? 'Leave' : 'Remove'}
                </button>
              )}
            </li>
          );
        })}
        {team.data?.invites.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-bold">{i.email}</p>
              <p className="text-[13px] text-muted">
                Invited as {i.role} · link works until {new Date(i.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <span className="chip chip-orange">Invited</span>
            {canInvite && (
              <button
                type="button"
                className="linkbtn text-[13px] text-danger"
                onClick={async () =>
                  team.setData(await api<Team>(`/team/invites/${i.id}`, undefined, 'DELETE'))
                }
              >
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>

      {canInvite && (
        <form
          onSubmit={invite}
          className="card card-flat grid items-end gap-3 sm:grid-cols-[1fr_200px_auto]"
          autoComplete="off"
        >
          <Field
            label="Invite by email"
            name="email"
            type="email"
            required
            placeholder="name@example.com"
          />
          <Select label="Role" name="role" defaultValue="agent">
            <option value="agent">Agent</option>
            <option value="admin">Admin</option>
          </Select>
          <button type="submit" className="btn btn-primary">
            Make invite link
          </button>
          <p className="text-[13px] text-muted sm:col-span-3">
            <b>Agent:</b> {ROLE_HELP.agent} <b>Admin:</b> {ROLE_HELP.admin}
          </p>
          {link && (
            <div className="grid gap-1 sm:col-span-3">
              <p className="text-[14px] font-bold">
                Send them this link (it works once, for a week). Switchboard doesn’t email it.
              </p>
              <code className="select-all break-all border-2 border-edge bg-surface-2 px-2 py-1 text-[13px]">
                {link}
              </code>
            </div>
          )}
        </form>
      )}
      <FormError message={error} />
    </section>
  );
}
