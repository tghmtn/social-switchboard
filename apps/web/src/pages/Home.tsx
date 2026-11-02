import { Link } from 'react-router';
import { type Me, type Overview, useApi } from '../api';
import { SquareIcon } from '../components/SquareIcons';
import { PageHeader, Stat } from '../ui';
import { Page } from './Shell';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
};

export function Home({ me }: { me: Me }) {
  const { data: o } = useApi<Overview>('/overview');
  const first = me.user.firstName;
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const steps = [
    { done: true, title: 'Create the owner account', detail: 'Done. You’re signed in.' },
    {
      done: (o?.liveFlows ?? 0) > 0,
      title: 'Build and publish an automation',
      detail:
        'Start from the lead magnet template: someone sends a keyword and gets the resource right away, and a “Send me more” tap collects their email.',
      to: '/automations',
    },
    {
      done: (o?.contacts ?? 0) > 0,
      title: 'Test it in the simulator',
      detail:
        'Chat with your automation the way a follower would, before it goes anywhere near Instagram.',
      to: '/simulator',
    },
    {
      done: (o?.instagram ?? 0) > 0,
      title: 'Connect Instagram',
      detail: 'A step-by-step guide walks you through Meta’s setup, checking each step as you go.',
      to: '/channels/instagram',
    },
  ];

  return (
    <Page>
      <PageHeader
        eyebrow={today}
        title={
          o && o.liveFlows === 0 ? (
            <>
              {greeting()}, {first}. Let’s build your <em className="hl">first automation</em>.
            </>
          ) : (
            <>
              {greeting()}, {first}.
            </>
          )
        }
        actions={
          <>
            <Link className="btn" to="/simulator">
              Open simulator
            </Link>
            <Link className="btn btn-primary" to="/automations?new=1">
              New automation
            </Link>
          </>
        }
      />

      <section aria-label="At a glance" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Contacts"
          value={o?.contacts ?? '–'}
          detail={o ? `+${o.newContacts7d} this week` : undefined}
        />
        <Stat label="Leads with email" value={o?.leads ?? '–'} detail="Ready to export as CSV" />
        <Stat
          label="Live automations"
          value={o?.liveFlows ?? '–'}
          detail={o ? `${o.activeRuns} conversations in progress` : undefined}
        />
        <Stat label="Messages sent" value={o?.sent7d ?? '–'} detail="In the last 7 days" />
      </section>

      <section aria-labelledby="setup-h" className="grid gap-4">
        <h2 id="setup-h" className="font-display text-display-md font-bold">
          Get set up
        </h2>
        <ol className="card divide-y-2 divide-line p-0">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-4 px-5 py-4">
              {s.done ? (
                <SquareIcon name="check" size={28} label="Done" />
              ) : (
                <span className="flex size-7 shrink-0 items-center justify-center border-2 border-edge text-sm font-bold tabular-nums">
                  {i + 1}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {s.to && !s.done ? (
                    <Link to={s.to} className="text-lg font-bold">
                      {s.title}
                    </Link>
                  ) : (
                    <p className="text-lg font-bold">{s.title}</p>
                  )}
                </div>
                <p className="mt-0.5 text-[15px] text-muted">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </Page>
  );
}
