import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, type Me, useApi } from '../api';
import { Field, FormError, Select } from '../ui';
import { CopyText } from './Channels';

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
  /** Email is set up, so invites can be sent instead of copied. */
  canEmail: boolean;
};
type Invited = { to: string; link: string; sent: boolean; sendError?: string };

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including roles.',
  admin: 'Everything except roles: channels, notifications, invites.',
  agent: 'The inbox, contacts and automations. No channel or team settings.',
};

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? (Object.values(err.fieldErrors())[0] ?? (err.code.includes(' ') ? err.code : fallback))
    : fallback;

export function TeamSection({ me }: { me: Me }) {
  const team = useApi<Team>('/team');
  const role = me.workspaces[0]?.role;
  const canInvite = role === 'owner' || role === 'admin';
  const canEmail = Boolean(team.data?.canEmail);
  const [invited, setInvited] = useState<Invited>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    // "Send invite" emails it; "Just make a link" (or no email set up) hands back the link.
    const send = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'send';
    const data = new FormData(form);
    const to = String(data.get('email') ?? '').trim();
    setError(undefined);
    setInvited(undefined);
    setBusy(true);
    try {
      const r = await api<Team & Omit<Invited, 'to'>>('/team/invites', {
        email: to,
        role: data.get('role'),
        send,
      });
      setInvited({ to, link: r.link, sent: r.sent, sendError: r.sendError });
      team.setData(r);
      form.reset();
    } catch (err) {
      setError(errorText(err, 'Couldn’t make the invite.'));
    } finally {
      setBusy(false);
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
          className="card card-flat grid items-end gap-3 sm:grid-cols-[1fr_200px]"
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
          <div className="grid gap-2 sm:col-span-2 sm:flex">
            {canEmail ? (
              <>
                <button type="submit" value="send" className="btn btn-primary" disabled={busy}>
                  Send invite
                </button>
                <button type="submit" value="link" className="btn" disabled={busy}>
                  Just make a link
                </button>
              </>
            ) : (
              <button type="submit" value="link" className="btn btn-primary" disabled={busy}>
                Make invite link
              </button>
            )}
          </div>
          <p className="text-[13px] text-muted sm:col-span-2">
            <b>Agent:</b> {ROLE_HELP.agent} <b>Admin:</b> {ROLE_HELP.admin}
            {!canEmail && (
              <>
                {' '}
                <Link to="/settings/notifications">Set up email</Link> and Switchboard can send
                invites for you.
              </>
            )}
          </p>
          {invited && (
            <div className="grid gap-1.5 border-l-4 border-primary bg-surface-2 px-3 py-2.5 text-[14px] sm:col-span-2">
              {invited.sent ? (
                <p>
                  <b>Invite sent to {invited.to}.</b> The link in it works once, for a week. If it
                  doesn’t arrive, share this one yourself:
                </p>
              ) : invited.sendError ? (
                <p>
                  <b>The email didn’t go</b> ({invited.sendError}), but the invite is ready. Send{' '}
                  {invited.to} this link yourself (it works once, for a week):
                </p>
              ) : (
                <p>
                  <b>Send {invited.to} this link.</b> It works once, for a week.
                </p>
              )}
              <CopyText text={invited.link} />
            </div>
          )}
        </form>
      )}
      <FormError message={error} />
    </section>
  );
}
