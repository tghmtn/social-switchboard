import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { AuthCard, Button, Field, FormError } from '../ui';

export function Setup({ onDone }: { onDone: () => void }) {
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
        <Field label="Your name" name="name" autoComplete="name" required error={errors.name} />
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
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Creating…' : 'Create owner account'}
        </Button>
      </form>
    </AuthCard>
  );
}
