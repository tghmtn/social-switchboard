import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app';

export const healthRoutes =
  ({ db, config }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // Docker polls this every 10s; keep it out of the info-level request log.
    app.get('/health', { logLevel: 'warn' }, async (req, reply) => {
      try {
        await db.execute(sql`select 1`);
        return { status: 'ok', version: config.version };
      } catch (err) {
        req.log.error(err, 'health check: database unreachable');
        return reply.code(503).send({ status: 'unavailable', version: config.version });
      }
    });
  };
