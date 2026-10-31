import { and, eq, lt } from 'drizzle-orm';
import { encryptSecret } from '../crypto';
import type { Db } from '../db/client';
import { instagramAccounts } from '../db/schema';
import { MetaError, refreshToken } from './graph';
import { decryptOptional } from './settings';

const DAY = 24 * 3_600_000;

/** Instagram tokens last 60 days. Refresh any expiring within 20 days (Meta allows it once a day). */
export async function refreshExpiringTokens(
  db: Db,
  appSecret: string,
  log?: (msg: string, f?: Record<string, unknown>) => void,
) {
  const soon = new Date(Date.now() + 20 * DAY);
  const due = await db
    .select()
    .from(instagramAccounts)
    .where(
      and(
        eq(instagramAccounts.status, 'connected'),
        lt(instagramAccounts.tokenExpiresAt, soon),
        lt(instagramAccounts.updatedAt, new Date(Date.now() - DAY)),
      ),
    );
  for (const account of due) {
    const token = decryptOptional(appSecret, account.accessTokenEnc);
    if (!token) continue;
    try {
      const fresh = await refreshToken(token);
      await db
        .update(instagramAccounts)
        .set({
          accessTokenEnc: encryptSecret(appSecret, fresh.accessToken),
          tokenExpiresAt: new Date(Date.now() + fresh.expiresIn * 1000),
          updatedAt: new Date(),
        })
        .where(eq(instagramAccounts.id, account.id));
      log?.('instagram token refreshed', { account: account.username });
    } catch (err) {
      const detail = err instanceof MetaError ? err.friendly : String(err);
      await db
        .update(instagramAccounts)
        .set({ status: 'error', statusDetail: detail, updatedAt: new Date() })
        .where(eq(instagramAccounts.id, account.id));
      log?.('instagram token refresh failed', { account: account.username, error: detail });
    }
  }
  return due.length;
}
