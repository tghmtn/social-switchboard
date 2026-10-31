import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { decryptSecret } from '../crypto';
import type { Db, Tx } from '../db/client';
import { instagramAccounts, metaApps } from '../db/schema';

// The workspace's Meta app (pasted in through the wizard) and its connected Instagram accounts.

export async function metaAppFor(db: Db | Tx, workspaceId: string) {
  const [row] = await db.select().from(metaApps).where(eq(metaApps.workspaceId, workspaceId));
  if (row) return row;
  // First visit: make the webhook verify token now so the wizard can show it.
  const [created] = await db
    .insert(metaApps)
    .values({ workspaceId, webhookVerifyToken: randomBytes(18).toString('base64url') })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db.select().from(metaApps).where(eq(metaApps.workspaceId, workspaceId));
  if (!again) throw new Error('meta app settings missing');
  return again;
}

export function decryptOptional(appSecret: string, sealed: string | null) {
  if (!sealed) return undefined;
  try {
    return decryptSecret(appSecret, sealed);
  } catch {
    return undefined; // APP_SECRET changed: the owner has to paste the secret again
  }
}

/**
 * Every secret Meta might sign with, across workspaces. Instagram-Login apps sign webhooks with the
 * Instagram app secret, others with the Facebook app secret, so we accept either (as OpenReply does).
 */
export async function metaSecrets(db: Db, appSecret: string, extra?: string) {
  const rows = await db.select().from(metaApps);
  const found = rows.flatMap((r) =>
    [
      decryptOptional(appSecret, r.instagramAppSecretEnc),
      decryptOptional(appSecret, r.facebookAppSecretEnc),
    ].flatMap((secret) =>
      secret ? [{ workspaceId: r.workspaceId as string | null, secret }] : [],
    ),
  );
  if (extra) found.push({ workspaceId: null, secret: extra });
  return found;
}

/** The account to send from: the one the contact talks to, else the workspace's first connected one. */
export async function accountFor(db: Db, workspaceId: string, accountRef: string | null) {
  if (accountRef) {
    const [byRef] = await db
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.igUserId, accountRef));
    if (byRef) return byRef;
  }
  const [first] = await db
    .select()
    .from(instagramAccounts)
    .where(
      and(
        eq(instagramAccounts.workspaceId, workspaceId),
        eq(instagramAccounts.status, 'connected'),
      ),
    )
    .orderBy(asc(instagramAccounts.connectedAt))
    .limit(1);
  return first;
}
