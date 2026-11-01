import { type FormEvent, useState } from 'react';
import { ApiError, api, useApi } from '../api';
import { AuthCard, Field, FormError } from '../ui';
import { Login } from './Login';

// Opened from a team invite link (/invite/<token>), signed in or not.

type Invite = {
  email: string;
  role: string;
  workspaceName: string;
  accountExists: boolean;
  signedInAs: string | null;
};

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const invite = useApi<Invite>(`/invites/${encodeURIComponent(token)}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const finish = () => {
    window.history.replaceState(null, '', '/inbox');
    onDone();
  };

  async function accept(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    setErrors({});
    try {
      await api(
        `/invites/${encodeURIComponent(token)}/accept`,
        e ? Object.fromEntries(new FormData(e.currentTarget)) : {},
      );
      finish();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_input') setErrors(err.fieldErrors());
      else
        setError(
          err instanceof ApiError && err.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : 'Couldn’t join. The link may have been used or expired.',
        );
    } finally {
      setBusy(false);
    }
  }

  if (invite.error)
    return (
      <AuthCard title="This invite doesn’t work" subtitle="It was used already, or it expired.">
        <p className="text-[15px]">Ask whoever invited you for a new link.</p>
      </AuthCard>
    );
  if (!invite.data) return null;
  const i = invite.data;
  const subtitle = `Join ${i.workspaceName} as ${i.role === 'admin' ? 'an admin' : 'an agent'}.`;

  // Already has an account: sign in as that email, then accept.
  if (i.accountExists && i.signedInAs !== i.email)
    return i.signedInAs ? (
      <AuthCard title="Wrong account" subtitle={subtitle}>
        <p className="text-[15px]">
          This invite is for <b>{i.email}</b>, but you’re signed in as {i.signedInAs}. Sign out,
          then open the link again.
        </p>
      </AuthCard>
    ) : (
      <Login onDone={() => void invite.reload()} />
    );

  if (i.accountExists)
    return (
      <AuthCard title="You’re invited" subtitle={subtitle}>
        <FormError message={error} />
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy}
          onClick={() => void accept()}
        >
          {busy ? 'Joining…' : 'Join the team'}
        </button>
      </AuthCard>
    );

  return (
    <AuthCard title="You’re invited" subtitle={subtitle}>
      <form onSubmit={accept} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Email" name="email" value={i.email} readOnly disabled />
        <Field
          label="First name"
          name="firstName"
          autoComplete="given-name"
          required
          error={errors.firstName}
        />
        <Field label="Last name" name="lastName" autoComplete="family-name" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 10 characters."
          error={errors.password}
        />
        <button type="submit" disabled={busy} className="btn btn-primary w-full">
          {busy ? 'Joining…' : 'Join the team'}
        </button>
      </form>
    </AuthCard>
  );
}
