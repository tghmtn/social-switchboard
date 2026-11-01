import { Moon, Sun } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { api, type Me } from '../api';
import { Icon } from '../components/Icon';
import { SquareIcon, type SquareIconName } from '../components/SquareIcons';
import { getTheme, setTheme, type ThemeChoice } from '../theme';
import { Avatar, Wordmark } from '../ui';

const NAV: { to: string; label: string; icon: SquareIconName; end?: boolean; phase?: number }[] = [
  { to: '/', label: 'Today', icon: 'home', end: true },
  { to: '/flows', label: 'Flows', icon: 'flow' },
  { to: '/contacts', label: 'Contacts', icon: 'kit' },
  { to: '/simulator', label: 'Simulator', icon: 'phone' },
  { to: '/channels', label: 'Channels', icon: 'chat' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox', phase: 3 },
  { to: '/settings', label: 'Settings', icon: 'sliders' },
];

/** The app frame: a 240px sidebar that becomes a scrolling top nav below 900px (per the theme). */
export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const workspace = me.workspaces[0];
  const [theme, setChoice] = useState(getTheme);
  const themeToggle = <ThemeToggle choice={theme} onChange={setChoice} />;

  async function signOut() {
    await api('/auth/logout', {});
    onSignOut();
  }

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] min-[900px]:grid-cols-[240px_minmax(0,1fr)] min-[900px]:grid-rows-1">
      <aside className="grid min-w-0 content-start gap-4 border-b-2 border-edge bg-surface px-4 py-3.5 min-[900px]:sticky min-[900px]:top-0 min-[900px]:h-dvh min-[900px]:grid-rows-[auto_1fr_auto] min-[900px]:gap-6 min-[900px]:border-r-2 min-[900px]:border-b-0 min-[900px]:py-5">
        <div className="flex items-center justify-between gap-3 pl-1">
          <Wordmark className="text-[19px]" />
          <div className="flex items-center gap-4 min-[900px]:hidden">
            {themeToggle}
            <button type="button" onClick={signOut} className="linkbtn">
              Sign out
            </button>
          </div>
        </div>
        <nav
          aria-label="App"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pt-0.5 pb-2 [scrollbar-width:thin] min-[900px]:mx-0 min-[900px]:grid min-[900px]:content-start min-[900px]:overflow-visible min-[900px]:p-0"
        >
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="navlink">
              <SquareIcon name={n.icon} />
              {n.label}
              {n.phase && (
                <span className="chip ml-auto px-1.5 py-0 text-[10px] text-muted">Soon</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="hidden items-center gap-3 min-[900px]:flex">
          <Avatar name={me.user.name} />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-bold">{me.user.name}</p>
            <p className="truncate text-[13px] text-muted">{workspace?.name}</p>
            <button type="button" onClick={signOut} className="linkbtn mt-1 text-[13px]">
              Sign out
            </button>
          </div>
          {themeToggle}
        </div>
      </aside>
      <main className="min-w-0">
        <Outlet />
      </main>
    </div>
  );
}

/** One click between light and dark. Settings → Appearance also offers "match my device". */
function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (c: ThemeChoice) => void;
}) {
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      className="flex size-9 shrink-0 items-center justify-center border-2 border-transparent hover:border-edge"
      aria-label={label}
      title={label}
      onClick={() => {
        const next = dark ? 'light' : 'dark';
        setTheme(next);
        onChange(next);
      }}
    >
      <Icon icon={dark ? Sun : Moon} size={22} line />
    </button>
  );
}

/** Standard page padding and width. The flow builder skips this to use the full screen. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={`mx-auto grid gap-8 px-4 py-8 sm:px-8 lg:px-10 ${wide ? 'max-w-[1400px]' : 'max-w-[1100px]'}`}
    >
      {children}
    </div>
  );
}
