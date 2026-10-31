import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { AuthCard, Button, Field, FormError } from '../ui';

export function Login({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/auth/login', Object.fromEntries(new FormData(e.currentTarget)));
      onDone();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 401 || status === 400
          ? 'That email and password don’t match.'
          : status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : 'Something went wrong. Check that the server is running and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Welcome back.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}
