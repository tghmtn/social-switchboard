import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/password';
import {
  createSession,
  deleteSession,
  publicUser,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../auth/sessions';
import { users, workspaceMembers, workspaces } from '../db/schema';
import { isPrivateAddress } from '../net';

// Arbitrary constant for pg_advisory_xact_lock, so two first-run requests can't both become owner.
const SETUP_LOCK_KEY = 7_340_001;

const email = z
  .email('Enter a valid email address.')
  .max(254)
  .transform((s) => s.toLowerCase());
const setupBody = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name.').max(60),
  lastName: z.string().trim().max(60).default(''),
  email,
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  workspaceName: z.string().trim().min(1, 'Give your workspace a name.').max(100),
  setupCode: z.string().trim().max(32).optional(),
});
const loginBody = z.object({ email, password: z.string().min(1).max(200) });

const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** One-time code for first-run setup from outside the home network; made on first need. */
let setupCode: string | undefined;
export const currentSetupCode = () => setupCode;

export const authRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const startSession = async (userId: string, req: FastifyRequest) => {
      const { token, expiresAt } = await createSession(db, userId);
      return [token, sessionCookieOptions(req.protocol === 'https', expiresAt)] as const;
    };
    const needsSetup = async () => !(await db.select({ id: users.id }).from(users).limit(1))[0];

    // From the home network anyone can run first-time setup. From outside (e.g. through the
    // tunnel), they also need the one-time code this server prints to its log, so a stranger who
    // finds a fresh install can't claim it.
    const codeRequired = (req: FastifyRequest) => {
      if (isPrivateAddress(req.ip)) return false;
      if (!setupCode) {
        setupCode = randomBytes(6).toString('base64url');
        req.log.warn(
          `First-time setup was opened from outside your network. Setup code: ${setupCode}`,
        );
      }
      return true;
    };

    app.get('/setup', async (req) => {
      const open = await needsSetup();
      return { needsSetup: open, codeRequired: open && codeRequired(req) };
    });

    // First run only: creates the owner account and the first workspace.
    app.post('/setup', { config: authRateLimit }, async (req, reply) => {
      const body = setupBody.parse(req.body);
      if (codeRequired(req) && body.setupCode !== setupCode) {
        return reply.code(403).send({ error: 'setup_code_required' });
      }
      const passwordHash = await hashPassword(body.password);

      const user = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
        const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
        if (existing) return null;

        const [created] = await tx
          .insert(users)
          .values({
            email: body.email,
            firstName: body.firstName,
            lastName: body.lastName,
            passwordHash,
          })
          .returning({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          });
        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: body.workspaceName, timeZone: config.timeZone })
          .returning({ id: workspaces.id });
        if (!created || !workspace) throw new Error('setup insert returned no rows');
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: workspace.id, userId: created.id, role: 'owner' });
        return created;
      });
      if (!user) return reply.code(409).send({ error: 'already_set_up' });

      reply.setCookie(SESSION_COOKIE, ...(await startSession(user.id, req)));
      return reply.code(201).send({ user: publicUser(user) });
    });

    app.post('/auth/login', { config: authRateLimit }, async (req, reply) => {
      const body = loginBody.parse(req.body);
      const [user] = await db.select().from(users).where(eq(users.email, body.email));
      const ok = await verifyPassword(body.password, user?.passwordHash ?? (await getDummyHash()));
      if (!user || !ok) return reply.code(401).send({ error: 'invalid_credentials' });

      reply.setCookie(SESSION_COOKIE, ...(await startSession(user.id, req)));
      return { user: publicUser(user) };
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
