import type { OutboundContent } from '../db/schema';

export type SendResult =
  | { status: 'sent'; externalId?: string }
  | { status: 'failed' | 'blocked'; error: string };

/**
 * A messaging channel. Phase 2 adds Instagram, which will also enforce the 24-hour window and
 * one-private-reply-per-comment rules here, returning "blocked" with the reason.
 */
export interface ChannelAdapter {
  readonly id: string;
  send(
    target: {
      workspaceId: string;
      contactId: string;
      externalId: string;
      accountRef: string | null;
    },
    content: OutboundContent,
  ): Promise<SendResult>;
}

/** The built-in test channel. Messages "arrive" by being stored; the simulator reads them back. */
export const simulatorChannel: ChannelAdapter = {
  id: 'simulator',
  send: async () => ({ status: 'sent' }),
};

export type ChannelRegistry = Map<string, ChannelAdapter>;

export const defaultChannels = (): ChannelRegistry =>
  new Map([[simulatorChannel.id, simulatorChannel]]);
