import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { AuthCard, Field, FormError } from '../ui';

export function Setup({ onDone, codeRequired }: { onDone: () => void; codeRequired: boolean }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(undefined);
    try {
      await api('/setup', Object.fromEntries(new FormData(e.currentTarget)));
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setErrors(err.fieldErrors());
      else if (err instanceof ApiError && err.status === 409) onDone();
      else if (err instanceof ApiError && err.status === 403)
        setErrors({
          setupCode: 'That setup code doesn’t match. Check the server log for the current one.',
        });
      else setFormError('Something went wrong. Check that the server is running and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Welcome! Let's set things up"
      subtitle="Create the owner account for this install. You can invite teammates later."
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={formError} />
        {codeRequired && (
          <Field
            label="Setup code"
            name="setupCode"
            required
            autoComplete="off"
            error={errors.setupCode}
            hint="You’re setting this up from outside your network. Run: docker compose logs app | grep 'Setup code'"
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="First name"
            name="firstName"
            autoComplete="given-name"
            required
            maxLength={60}
            error={errors.firstName}
          />
          <Field
            label="Last name"
            name="lastName"
            autoComplete="family-name"
            maxLength={60}
            error={errors.lastName}
          />
        </div>
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          error={errors.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          hint="At least 10 characters."
          error={errors.password}
        />
        <Field
          label="Workspace name"
          name="workspaceName"
          placeholder="Your business or brand"
          required
          error={errors.workspaceName}
        />
        <button type="submit" disabled={busy} className="btn btn-primary w-full">
          {busy ? 'Creating…' : 'Create owner account'}
        </button>
      </form>
    </AuthCard>
  );
}
