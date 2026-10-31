import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/password';
import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../auth/sessions';
import { users, workspaceMembers, workspaces } from '../db/schema';

// Arbitrary constant for pg_advisory_xact_lock, so two first-run requests can't both become owner.
const SETUP_LOCK_KEY = 7_340_001;

const email = z
  .email('Enter a valid email address.')
  .max(254)
  .transform((s) => s.toLowerCase());
const setupBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(100),
  email,
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  workspaceName: z.string().trim().min(1, 'Give your workspace a name.').max(100),
});
const loginBody = z.object({ email, password: z.string().min(1).max(200) });

const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const authRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const startSession = async (userId: string) => {
      const { token, expiresAt } = await createSession(db, userId);
      return [token, sessionCookieOptions(config, expiresAt)] as const;
    };

    app.get('/setup', async () => {
      const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
      return { needsSetup: !anyUser };
    });

    // First run only: creates the owner account and the first workspace.
    app.post('/setup', { config: authRateLimit }, async (req, reply) => {
      const body = setupBody.parse(req.body);
      const passwordHash = await hashPassword(body.password);

      const user = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
        const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
        if (existing) return null;

        const [created] = await tx
          .insert(users)
          .values({ email: body.email, name: body.name, passwordHash })
          .returning({ id: users.id, email: users.email, name: users.name });
        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: body.workspaceName })
          .returning({ id: workspaces.id });
        if (!created || !workspace) throw new Error('setup insert returned no rows');
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: workspace.id, userId: created.id, role: 'owner' });
        return created;
      });
      if (!user) return reply.code(409).send({ error: 'already_set_up' });

      reply.setCookie(SESSION_COOKIE, ...(await startSession(user.id)));
      return reply.code(201).send({ user });
    });

    app.post('/auth/login', { config: authRateLimit }, async (req, reply) => {
      const body = loginBody.parse(req.body);
      const [user] = await db.select().from(users).where(eq(users.email, body.email));
      const ok = await verifyPassword(body.password, user?.passwordHash ?? (await getDummyHash()));
      if (!user || !ok) return reply.code(401).send({ error: 'invalid_credentials' });

      reply.setCookie(SESSION_COOKIE, ...(await startSession(user.id)));
      return { user: { id: user.id, email: user.email, name: user.name } };
    });

    app.post('/auth/logout', async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await deleteSession(db, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(204).send();
    });

    app.get('/me', async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
      const memberships = await db
        .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, req.user.id));
      return { user: req.user, workspaces: memberships };
    });
  };
