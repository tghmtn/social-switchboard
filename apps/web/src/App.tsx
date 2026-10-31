import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError, api, type Me } from './api';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
import { ComingSoon, Home, Settings, Shell, sections } from './pages/Shell';

type State =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'ready'; me: Me }
  | { kind: 'offline' };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const { needsSetup } = await api<{ needsSetup: boolean }>('/setup');
      if (needsSetup) return setState({ kind: 'setup' });
      setState({ kind: 'ready', me: await api<Me>('/me') });
    } catch (err) {
      setState(
        err instanceof ApiError && err.status === 401 ? { kind: 'login' } : { kind: 'offline' },
      );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  switch (state.kind) {
    case 'loading':
      return null;
    case 'setup':
      return <Setup onDone={load} />;
    case 'login':
      return <Login onDone={load} />;
    case 'offline':
      return (
        <main className="flex min-h-dvh items-center justify-center px-4 text-center">
          <div>
            <p className="font-medium">Can’t reach the server.</p>
            <button
              type="button"
              onClick={load}
              className="mt-2 text-sm text-orange-600 hover:underline"
            >
              Try again
            </button>
          </div>
        </main>
      );
    case 'ready':
      return (
        <BrowserRouter>
          <Routes>
            <Route element={<Shell me={state.me} onSignOut={() => setState({ kind: 'login' })} />}>
              <Route index element={<Home me={state.me} />} />
              {sections.map((s) => (
                <Route key={s.to} path={s.to} element={<ComingSoon section={s} />} />
              ))}
              <Route path="/settings" element={<Settings me={state.me} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      );
  }
}
