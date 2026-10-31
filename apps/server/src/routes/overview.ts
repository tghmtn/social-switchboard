import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { RouteDeps } from '../app';
import { requireWorkspace, who } from './guard';

/** The numbers on the Home page. One round trip, all scoped to the workspace. */
export const overviewRoutes =
  ({ db }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    app.get('/overview', async (req) => {
      const { workspace } = who(req);
      const ws = workspace.id;
      const result = await db.execute<{
        contacts: number;
        new_contacts_7d: number;
        live_flows: number;
        active_runs: number;
        sent_7d: number;
        leads: number;
      }>(sql`select
        (select count(*)::int from contacts where workspace_id = ${ws}) as contacts,
        (select count(*)::int from contacts where workspace_id = ${ws} and created_at > now() - interval '7 days') as new_contacts_7d,
        (select count(*)::int from flows where workspace_id = ${ws} and archived_at is null and published_version_id is not null) as live_flows,
        (select count(*)::int from runs where workspace_id = ${ws} and status = 'waiting') as active_runs,
        (select count(*)::int from messages where workspace_id = ${ws} and direction = 'out' and status = 'sent' and created_at > now() - interval '7 days') as sent_7d,
        (select count(*)::int from contacts where workspace_id = ${ws} and email is not null) as leads`);
      const r = result.rows[0];
      return {
        contacts: r?.contacts ?? 0,
        newContacts7d: r?.new_contacts_7d ?? 0,
        liveFlows: r?.live_flows ?? 0,
        activeRuns: r?.active_runs ?? 0,
        sent7d: r?.sent_7d ?? 0,
        leads: r?.leads ?? 0,
      };
    });
  };
