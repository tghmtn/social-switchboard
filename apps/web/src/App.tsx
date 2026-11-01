import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError, api, type Me } from './api';
import { AcceptInvite } from './pages/AcceptInvite';
import { Channels, InstagramChannel } from './pages/Channels';
import { ContactDetail } from './pages/ContactDetail';
import { Contacts } from './pages/Contacts';
import { FacebookChannel } from './pages/FacebookChannel';
import { FlowEditor } from './pages/FlowEditor';
import { Flows } from './pages/Flows';
import { Home } from './pages/Home';
import { Inbox } from './pages/Inbox';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { Shell } from './pages/Shell';
import { SimulatorPage } from './pages/SimulatorPage';

type State =
  | { kind: 'loading' }
  | { kind: 'setup'; codeRequired: boolean }
  | { kind: 'login' }
  | { kind: 'ready'; me: Me }
  | { kind: 'offline' };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const { needsSetup, codeRequired } = await api<{
        needsSetup: boolean;
        codeRequired?: boolean;
      }>('/setup');
      if (needsSetup) return setState({ kind: 'setup', codeRequired: Boolean(codeRequired) });
      setState({ kind: 'ready', me: await api<Me>('/me') });
    } catch (err) {
      setState(
        err instanceof ApiError && err.status === 401 ? { kind: 'login' } : { kind: 'offline' },
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A team invite link works signed in or out, so it comes before the usual screens.
  const invite = window.location.pathname.match(/^\/invite\/([\w-]+)$/)?.[1];
  if (invite && state.kind !== 'loading' && state.kind !== 'offline')
    return <AcceptInvite token={invite} onDone={load} />;

  switch (state.kind) {
    case 'loading':
      return null;
    case 'setup':
      return <Setup onDone={load} codeRequired={state.codeRequired} />;
    case 'login':
      return <Login onDone={load} />;
    case 'offline':
      return (
        <main className="flex min-h-dvh items-center justify-center px-4 text-center">
          <div className="card grid gap-3">
            <p className="font-bold">Can’t reach the server.</p>
            <button type="button" onClick={load} className="btn btn-sm">
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
              <Route path="/flows" element={<Flows />} />
              <Route path="/flows/:id" element={<FlowEditor />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/contacts/:id" element={<ContactDetail />} />
              <Route path="/simulator" element={<SimulatorPage />} />
              <Route path="/channels" element={<Channels />} />
              <Route path="/channels/instagram" element={<InstagramChannel />} />
              <Route path="/channels/facebook" element={<FacebookChannel />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/inbox/:id" element={<Inbox />} />
              <Route path="/settings" element={<Settings me={state.me} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      );
  }
}
