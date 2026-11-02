import { Simulator } from '../components/Simulator';
import { PageHeader } from '../ui';
import { Page } from './Shell';

export function SimulatorPage() {
  return (
    <Page wide>
      <PageHeader eyebrow="Test like a follower" title="Simulator" />
      <p className="-mt-4 max-w-2xl text-[15px] text-muted">
        You’re a test contact here. Published automations answer your keywords, quick replies and
        timeouts exactly as they will on Instagram. Nothing you do here reaches a real person.
      </p>
      <div className="h-[min(720px,calc(100dvh-220px))] min-h-[480px]">
        <Simulator />
      </div>
    </Page>
  );
}
