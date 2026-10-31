import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { api, type Health, type Me } from '../api';
import { Logo, PhaseBadge } from '../ui';

const icon = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  flows:
    'M6 3v6m0 0a3 3 0 1 0 0 6m0-6a3 3 0 1 1 0 6m0 0v6m12-12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0c0 6-12 3-12 9',
  contacts:
    'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  channels: 'M9 7V3m6 4V3M7 7h10v4a5 5 0 0 1-10 0zm5 9v5',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2m3.5-7h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
};

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export const sections = [
  {
    to: '/flows',
    label: 'Flows',
    icon: icon.flows,
    phase: 1,
    blurb:
      'Build automated conversations on a visual canvas, and test them in the built-in simulator before they go live.',
  },
  {
    to: '/contacts',
    label: 'Contacts',
    icon: icon.contacts,
    phase: 1,
    blurb:
      'Everyone who talks to you, with tags, custom fields and consent records. Export to CSV any time.',
  },
  {
    to: '/channels',
    label: 'Channels',
    icon: icon.channels,
    phase: 2,
    blurb:
      'Connect Instagram first: comment-to-DM, DM keywords and story replies. Messenger, web chat and email follow.',
  },
  {
    to: '/inbox',
    label: 'Inbox',
    icon: icon.inbox,
    phase: 3,
    blurb:
      'Every conversation in one place. Take over from the bot, assign to a teammate, leave notes.',
  },
] as const;

export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const workspace = me.workspaces[0];
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
      isActive
        ? 'bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
        : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100'
    }`;

  async function signOut() {
    await api('/auth/logout', {});
    onSignOut();
  }

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b border-stone-200 bg-white md:flex md:w-64 md:shrink-0 md:flex-col md:border-r md:border-b-0 dark:border-stone-800 dark:bg-stone-900">
        <div className="flex items-center gap-3 px-4 py-4 md:px-5 md:py-5">
          <Logo />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Social Switchboard</p>
            <p className="truncate text-xs text-stone-500">{workspace?.name}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="text-xs font-medium text-stone-500 hover:text-orange-600 md:hidden"
          >
            Sign out
          </button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-visible md:pb-0">
          <NavLink to="/" end className={link}>
            <Icon d={icon.home} /> Home
          </NavLink>
          {sections.map((s) => (
            <NavLink key={s.to} to={s.to} className={link}>
              <Icon d={s.icon} /> {s.label}
            </NavLink>
          ))}
          <NavLink to="/settings" className={link}>
            <Icon d={icon.settings} /> Settings
          </NavLink>
        </nav>
        <div className="hidden border-t border-stone-200 px-5 py-4 md:block dark:border-stone-800">
          <p className="truncate text-sm font-medium">{me.user.name}</p>
          <p className="truncate text-xs text-stone-500">{me.user.email}</p>
          <button
            type="button"
            onClick={signOut}
            className="mt-2 text-xs font-medium text-stone-500 hover:text-orange-600"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 px-4 py-8 sm:px-8 lg:px-12">
        <div className="mx-auto max-w-4xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function Home({ me }: { me: Me }) {
  const [health, setHealth] = useState<Health>();
  useEffect(() => {
    api<Health>('/health').then(setHealth, () => setHealth(undefined));
  }, []);

  const steps = [
    { done: true, title: 'Create the owner account', detail: 'Done. You’re signed in.' },
    ...sections
      .slice(0, 3)
      .map((s) => ({ done: false, title: s.label, detail: s.blurb, phase: s.phase })),
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {me.user.name.split(' ')[0]}
        </h1>
        <p className="mt-1 text-stone-500 dark:text-stone-400">
          This install is up and running. Here’s what’s coming as the build progresses.
        </p>
      </header>

      <section className="rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <h2 className="border-b border-stone-200 px-5 py-3 text-sm font-semibold dark:border-stone-800">
          Getting started
        </h2>
        <ol className="divide-y divide-stone-200 dark:divide-stone-800">
          {steps.map((s) => (
            <li key={s.title} className="flex gap-4 px-5 py-4">
              <span
                className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  s.done
                    ? 'bg-orange-600 text-white'
                    : 'border border-stone-300 text-stone-400 dark:border-stone-700'
                }`}
              >
                {s.done ? '✓' : ''}
                <span className="sr-only">{s.done ? 'Done:' : 'Not yet:'}</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{s.title}</p>
                  {'phase' in s && s.phase ? <PhaseBadge phase={s.phase} /> : null}
                </div>
                <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Server"
          value={health ? 'Healthy' : 'Checking…'}
          detail={health ? `Version ${health.version}` : ''}
        />
        <Stat
          label="Backups"
          value="Nightly at 03:30"
          detail="The last 14 are kept in the backups volume."
        />
      </section>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
      <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{detail}</p>
    </div>
  );
}

export function ComingSoon({ section }: { section: (typeof sections)[number] }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{section.label}</h1>
        <PhaseBadge phase={section.phase} />
      </div>
      <div className="mt-6 rounded-2xl border border-dashed border-stone-300 px-6 py-12 text-center dark:border-stone-700">
        <p className="mx-auto max-w-md text-stone-600 dark:text-stone-400">{section.blurb}</p>
        <p className="mt-3 text-sm text-stone-400">
          Arrives in Phase {section.phase} of the roadmap.
        </p>
      </div>
    </div>
  );
}

export function Settings({ me }: { me: Me }) {
  const rows = [
    ['Name', me.user.name],
    ['Email', me.user.email],
    ...me.workspaces.map((w) => ['Workspace', `${w.name} (${w.role})`]),
  ];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <dl className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
        {rows.map(([k, v]) => (
          <div key={`${k}-${v}`} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:gap-4">
            <dt className="w-32 shrink-0 text-sm text-stone-500">{k}</dt>
            <dd className="text-sm font-medium break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-stone-500">
        More settings arrive with later phases: channels, team and AI.
      </p>
    </div>
  );
}
