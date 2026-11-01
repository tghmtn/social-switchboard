import type { Db } from '../db/client';
import { facebookChannel } from '../facebook/channel';
import { instagramChannel } from '../instagram/channel';
import { type ChannelRegistry, simulatorChannel } from './channels';

/** Every channel this install can send on. */
export const allChannels = (db: Db, appSecret: string): ChannelRegistry =>
  new Map([
    [simulatorChannel.id, simulatorChannel],
    ['instagram', instagramChannel(db, appSecret)],
    ['facebook', facebookChannel(db, appSecret)],
  ]);
