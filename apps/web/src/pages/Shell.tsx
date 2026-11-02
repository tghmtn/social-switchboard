import { Moon, Sun } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, type Me, useApi } from '../api';
import { AssistantPanel } from '../components/Assistant';
import { Icon } from '../components/Icon';
import { InstallSheet } from '../components/InstallSheet';
import { SquareIcon, type SquareIconName } from '../components/SquareIcons';
import { markNudged, shouldNudge, useInstallWay } from '../install';
import { setAppBadge } from '../push';
import { getTheme, setTheme, type ThemeChoice } from '../theme';
import { Avatar, Wordmark } from '../ui';

const NAV: { to: string; label: string; icon: SquareIconName; end?: boolean }[] = [
  { to: '/', label: 'Today', icon: 'home', end: true },
  { to: '/automations', label: 'Automations', icon: 'flow' },
  { to: '/contacts', label: 'Contacts', icon: 'kit' },
  { to: '/simulator', label: 'Simulator', icon: 'phone' },
  { to: '/channels', label: 'Channels', icon: 'chat' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/settings', label: 'Settings', icon: 'sliders' },
];

/** On phones: the four places people go most, plus More for the rest. */
const TABS: { to: string; label: string; icon: SquareIconName; end?: boolean }[] = [
  { to: '/', label: 'Today', icon: 'home', end: true },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/automations', label: 'Automations', icon: 'flow' },
  { to: '/contacts', label: 'Contacts', icon: 'kit' },
];
const MORE: { to: string; label: string; icon: SquareIconName; detail: string }[] = [
  { to: '/channels', label: 'Channels', icon: 'chat', detail: 'Instagram, Facebook, web chat' },
  {
    to: '/simulator',
    label: 'Simulator',
    icon: 'phone',
    detail: 'Test automations like a follower',
  },
  { to: '/settings', label: 'Settings', icon: 'sliders', detail: 'Team, alerts, AI, fields' },
];

/**
 * The app frame. From 900px: a 240px sidebar. On phones, a slim top bar and a bottom tab bar
 * (Today, Inbox, Automations, Contacts, More), and a conversation or the automation builder takes the whole
 * screen, with its own back button.
 */
export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const workspace = me.workspaces[0];
  const [theme, setChoice] = useState(getTheme);
  const location = useLocation();
  // Open conversations with something new, for the Inbox link.
  const inbox = useApi<{ unread: number }>('/inbox/summary');
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void inbox.reload();
    }, 20_000);
    return () => clearInterval(t);
  }, [inbox.reload]);
  const unread = inbox.data?.unread ?? 0;
  // The count on the installed app's icon, too.
  useEffect(() => {
    if (inbox.data) setAppBadge(inbox.data.unread);
  }, [inbox.data]);
  // Tapping a notification while the app is open: go to its conversation without a reload.
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent<{ type?: string; path?: string }>) => {
      if (e.data?.type === 'open' && e.data.path?.startsWith('/')) navigate(e.data.path);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
  const [assistant, setAssistant] = useState(false);
  const [more, setMore] = useState(false);
  // On a phone, once: suggest adding the app to the Home Screen (More → Get the app after that).
  const installWay = useInstallWay();
  const [install, setInstall] = useState(false);
  useEffect(() => {
    if (!installWay || !shouldNudge()) return;
    const t = setTimeout(() => {
      markNudged();
      setInstall(true);
    }, 2500);
    return () => clearTimeout(t);
  }, [installWay]);
  // A new page closes the More sheet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation
  useEffect(() => setMore(false), [location.pathname]);
  // Full screen on phones: a conversation and the automation builder bring their own header.
  const immersive = /^\/(inbox|automations)\/[^/]+/.test(location.pathname);
  const moreActive = MORE.some((m) => location.pathname.startsWith(m.to));

  async function signOut() {
    await api('/auth/logout', {});
    onSignOut();
  }

  return (
    <div className="min-h-dvh min-[900px]:grid min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
      {/* Phones: a slim top bar. */}
      <header
        className={`sticky top-0 z-30 flex items-center justify-between gap-3 border-b-2 border-edge bg-surface px-4 pt-[env(safe-area-inset-top)] min-[900px]:hidden ${immersive ? 'hidden' : ''}`}
      >
        <Wordmark className="py-3 text-[19px]" />
        <button
          type="button"
          onClick={() => setAssistant(true)}
          aria-expanded={assistant}
          className="flex h-10 items-center gap-1.5 border-2 border-edge bg-surface-2 px-3 text-[14px] font-bold"
        >
          <span aria-hidden>✨</span> Ask AI
        </button>
      </header>

      {/* From 900px: the sidebar. */}
      <aside className="hidden min-w-0 border-r-2 border-edge bg-surface px-4 py-5 min-[900px]:sticky min-[900px]:top-0 min-[900px]:grid min-[900px]:h-dvh min-[900px]:grid-rows-[auto_1fr_auto] min-[900px]:gap-6">
        <Wordmark className="pl-1 text-[19px]" />
        <nav aria-label="App" className="grid content-start gap-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="navlink">
              <SquareIcon name={n.icon} />
              {n.label}
              {n.to === '/inbox' && unread > 0 && (
                <span className="chip chip-lime ml-auto px-1.5 py-0 text-[11px] tabular-nums">
                  {unread}
                </span>
              )}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setAssistant(true)}
            aria-expanded={assistant}
            className="navlink w-full text-left"
          >
            ✨ Assistant
          </button>
        </nav>
        <div className="flex items-center gap-3">
          <Avatar name={me.user.name} />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-bold">{me.user.name}</p>
            <p className="truncate text-[13px] text-muted">{workspace?.name}</p>
            <button type="button" onClick={signOut} className="linkbtn mt-1 text-[13px]">
              Sign out
            </button>
          </div>
          <ThemeToggle choice={theme} onChange={setChoice} />
        </div>
      </aside>

      <main
        className={`min-w-0 min-[900px]:pb-0 ${immersive ? '' : 'pb-[calc(4.25rem+env(safe-area-inset-bottom))]'}`}
      >
        <Outlet />
      </main>

      {/* Phones: the tab bar. */}
      <nav
        aria-label="App"
        className={`fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t-2 border-edge bg-surface pb-[env(safe-area-inset-bottom)] min-[900px]:hidden ${immersive ? 'hidden' : ''}`}
      >
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="tab">
            <span className="relative">
              <SquareIcon name={t.icon} />
              {t.to === '/inbox' && unread > 0 && (
                <span className="absolute -top-1.5 -right-2.5 min-w-5 border-2 border-edge bg-highlight px-1 text-center text-[10px] leading-4 font-extrabold text-ink tabular-nums">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
            {t.label}
          </NavLink>
        ))}
        <button
          type="button"
          className="tab"
          aria-expanded={more}
          aria-current={moreActive ? 'page' : undefined}
          onClick={() => setMore(true)}
        >
          <span className="grid size-6 place-items-center text-[20px] leading-none" aria-hidden>
            ⋯
          </span>
          More
        </button>
      </nav>

      {more && (
        <MoreSheet
          me={me}
          theme={theme}
          onTheme={setChoice}
          onAssistant={() => {
            setMore(false);
            setAssistant(true);
          }}
          onSignOut={signOut}
          onInstall={
            installWay
              ? () => {
                  setMore(false);
                  setInstall(true);
                }
              : undefined
          }
          onClose={() => setMore(false)}
        />
      )}
      {install && installWay && <InstallSheet way={installWay} onClose={() => setInstall(false)} />}
      {assistant && <AssistantPanel me={me} onClose={() => setAssistant(false)} />}
    </div>
  );
}

/** Phones: everything not in the tab bar, as a sheet from the bottom. */
function MoreSheet({
  me,
  theme,
  onTheme,
  onAssistant,
  onSignOut,
  onInstall,
  onClose,
}: {
  me: Me;
  theme: ThemeChoice;
  onTheme: (c: ThemeChoice) => void;
  onAssistant: () => void;
  onSignOut: () => void;
  /** Set while the app isn't on this phone's Home Screen yet. */
  onInstall?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 min-[900px]:hidden">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="More"
        className="sheet absolute inset-x-0 bottom-0 grid gap-1 border-t-2 border-edge bg-surface px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      >
        <span className="mx-auto mb-2 h-1.5 w-10 bg-line" aria-hidden />
        {MORE.map((m) => (
          <NavLink key={m.to} to={m.to} className="sheet-row">
            <SquareIcon name={m.icon} />
            <span className="grid flex-1 leading-tight">
              <span className="font-bold">{m.label}</span>
              <span className="text-[13px] font-normal text-muted">{m.detail}</span>
            </span>
            <span className="text-muted" aria-hidden>
              ›
            </span>
          </NavLink>
        ))}
        <button type="button" className="sheet-row" onClick={onAssistant}>
          <span className="grid size-6 place-items-center" aria-hidden>
            ✨
          </span>
          <span className="grid flex-1 text-left leading-tight">
            <span className="font-bold">Assistant</span>
            <span className="text-[13px] font-normal text-muted">
              Build automations, check setup
            </span>
          </span>
        </button>
        {onInstall && (
          <button type="button" className="sheet-row" onClick={onInstall}>
            <img src="/icon-192.png" alt="" className="size-6 border border-edge" />
            <span className="grid flex-1 text-left leading-tight">
              <span className="font-bold">Get the app</span>
              <span className="text-[13px] font-normal text-muted">
                Add Switchboard to your Home Screen
              </span>
            </span>
          </button>
        )}
        <div className="mt-2 flex items-center gap-3 border-t-2 border-line px-2 pt-3">
          <Avatar name={me.user.name} />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate font-bold">{me.user.name}</span>
            <span className="truncate text-[13px] text-muted">{me.workspaces[0]?.name}</span>
          </span>
          <ThemeToggle choice={theme} onChange={onTheme} />
          <button type="button" className="btn btn-sm" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
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

/** Standard page padding and width. The automation builder skips this to use the full screen. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={`mx-auto grid gap-6 px-4 pt-5 pb-8 sm:gap-8 sm:px-8 sm:pt-8 lg:px-10 ${wide ? 'max-w-[1400px]' : 'max-w-[1100px]'}`}
    >
      {children}
    </div>
  );
}
