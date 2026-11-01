import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { asc, eq } from 'drizzle-orm';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { findSessionUser, SESSION_COOKIE, sessionCookieOptions } from './auth/sessions';
import type { Config } from './config';
import type { Db } from './db/client';
import { workspaceMembers, workspaces } from './db/schema';
import { notifier } from './notify';
import { authRoutes } from './routes/auth';
import { contactRoutes } from './routes/contacts';
import { flowRoutes } from './routes/flows';
import { healthRoutes } from './routes/health';
import { inboxRoutes } from './routes/inbox';
import { instagramPublicRoutes, instagramRoutes } from './routes/instagram';
import { legalRoutes } from './routes/legal';
import { libraryRoutes } from './routes/library';
import { overviewRoutes } from './routes/overview';
import { simulatorRoutes } from './routes/simulator';
import { workspaceRoutes } from './routes/workspace';
import type { ChannelRegistry } from './runtime/channels';
import { allChannels } from './runtime/registry';
import type { RuntimeDeps } from './runtime/runtime';

export type SessionUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
};

export type RequestWorkspace = { id: string; role: 'owner' | 'admin' | 'agent'; timeZone: string };

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    workspace: RequestWorkspace | null;
  }
}

export type AppDeps = { db: Db; config: Config; channels?: ChannelRegistry; now?: () => Date };
export type RouteDeps = AppDeps & { runtime: RuntimeDeps };

export async function buildApp(deps: AppDeps, logger: FastifyServerOptions['logger'] = true) {
  const { config } = deps;
  // Trust forwarding headers only from proxies on private networks (Caddy, the tunnel), so
  // req.ip is the real visitor and req.protocol is "https" when they came through the tunnel.
  const app = Fastify({
    logger,
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
    bodyLimit: 1024 * 1024,
  });

  // JSON only. Combined with SameSite=Lax cookies this blocks cross-site form posts.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
  app.decorateRequest('workspace', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const found = await findSessionUser(deps.db, token);
    if (!found) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    req.user = found.user;
    reply.setCookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(req.protocol === 'https', found.expiresAt),
    );
    // One workspace per install for now; the first membership is the active one.
    const [membership] = await deps.db
      .select({ id: workspaces.id, role: workspaceMembers.role, timeZone: workspaces.timeZone })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, found.user.id))
      .orderBy(asc(workspaceMembers.createdAt))
      .limit(1);
    req.workspace = membership ?? null;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_input', issues: err.issues });
    }
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal_error' });
  });

  const routeDeps: RouteDeps = {
    ...deps,
    runtime: {
      db: deps.db,
      channels: deps.channels ?? allChannels(deps.db, config.appSecret),
      now: deps.now,
      log: (msg, fields) => app.log.info(fields ?? {}, msg),
      notify: notifier({
        db: deps.db,
        appSecret: config.appSecret,
        publicUrl: config.publicUrl,
        log: (msg, fields) => app.log.warn(fields ?? {}, msg),
      }),
    },
  };
  await app.register(healthRoutes(deps), { prefix: '/api' });
  await app.register(authRoutes(deps), { prefix: '/api' });
  await app.register(legalRoutes(routeDeps));
  await app.register(instagramPublicRoutes(routeDeps), { prefix: '/api' });
  for (const routes of [
    contactRoutes,
    libraryRoutes,
    flowRoutes,
    simulatorRoutes,
    overviewRoutes,
    instagramRoutes,
    inboxRoutes,
    workspaceRoutes,
  ]) {
    await app.register(routes(routeDeps), { prefix: '/api' });
  }

  // Serve the built web app, falling back to index.html for client-side routes.
  const hasWeb = existsSync(join(config.webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      setHeaders: (reply, filePath) => {
        reply.header(
          'cache-control',
          filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
