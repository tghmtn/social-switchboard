import { EmptyState, PageHeader } from '../ui';
import { Page } from './Shell';

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
