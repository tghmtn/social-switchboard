import { EmptyState, PageHeader } from '../ui';
import { Page } from './Shell';

export function Channels() {
  return (
    <Page>
      <PageHeader title="Channels" />
      <EmptyState
        icon="chat"
        title="Instagram is next"
        body={
          <>
            Phase 2 connects your Instagram professional account: keyword comments become DMs, plus
            DM keywords and story replies. Until then, everything works in the{' '}
            <a href="/simulator">simulator</a>.
          </>
        }
        action={<span className="chip">Phase 2</span>}
      />
    </Page>
  );
}

export function Inbox() {
  return (
    <Page>
      <PageHeader title="Inbox" />
      <EmptyState
        icon="inbox"
        title="Every conversation in one place"
        body="Take over from a flow, assign conversations to teammates and leave notes. Free for any team size."
        action={<span className="chip">Phase 3</span>}
      />
    </Page>
  );
}
