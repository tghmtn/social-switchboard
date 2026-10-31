import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { SessionUser } from '../app';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';

/** The user as the API returns it, with a ready-made full name for display. */
export const publicUser = (u: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}): SessionUser => ({
  id: u.id,
  email: u.email,
  firstName: u.firstName,
  lastName: u.lastName,
  name: [u.firstName, u.lastName].filter(Boolean).join(' '),
});

export const SESSION_COOKIE = 'ss_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Sessions used within the last half of their life get extended, so active users stay signed in.
const RENEW_BELOW_MS = SESSION_TTL_MS / 2;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** `secure` follows how this request arrived: https through the tunnel, plain http on the home network. */
export function sessionCookieOptions(secure: boolean, expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    expires: expiresAt,
  };
}

export async function createSession(db: Db, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function findSessionUser(db: Db, token: string) {
  const id = hashToken(token);
  const [row] = await db
    .select({
      sessionExpiresAt: sessions.expiresAt,
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  if (!row) return null;

  const { sessionExpiresAt, ...user } = row;
  let expiresAt = sessionExpiresAt;
  if (expiresAt.getTime() - Date.now() < RENEW_BELOW_MS) {
    expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
  }
  return { user: publicUser(user), expiresAt };
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}
