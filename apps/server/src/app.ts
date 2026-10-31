import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { findSessionUser, SESSION_COOKIE, sessionCookieOptions } from './auth/sessions';
import type { Config } from './config';
import type { Db } from './db/client';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';

export type SessionUser = { id: string; email: string; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export type AppDeps = { db: Db; config: Config };

export async function buildApp(deps: AppDeps, logger: FastifyServerOptions['logger'] = true) {
  const { config } = deps;
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 1024 * 1024 });

  // JSON only. Combined with SameSite=Lax cookies this blocks cross-site form posts.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
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
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config, found.expiresAt));
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

  await app.register(healthRoutes(deps), { prefix: '/api' });
  await app.register(authRoutes(deps), { prefix: '/api' });

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
