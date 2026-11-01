import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { encryptSecret, signToken, verifyToken } from '../crypto';
import type { Db } from '../db/client';
import { facebookPages, metaApps } from '../db/schema';
import * as fb from '../facebook/graph';
import { MetaError } from '../instagram/graph';
import { decryptOptional, metaAppFor } from '../instagram/settings';
import { notFound, requireAdmin, requireWorkspace, who } from './guard';
import { metaUrls } from './instagram';

// Facebook Pages: connect through Facebook Login with the same Meta app as Instagram, pick
// which Pages, and their comments and Messenger messages arrive on the same webhook.

const STATE_MAX_AGE = 15 * 60 * 1000;
/** Pages from a login are kept this long for the owner to pick from. */
const PENDING_MAX_AGE = 60 * 60 * 1000;

export const facebookRedirect = (publicUrl: string) => `${publicUrl}/api/facebook/callback`;

type Pending = fb.ListedPage[];

/** The Meta app ID for Facebook Login: set on its own, or the one in the Instagram Login URL. */
const appIdOf = (s: { facebookAppId: string | null; loginUrl: string | null }) =>
  s.facebookAppId ?? (s.loginUrl ? new URL(s.loginUrl).searchParams.get('client_id') : null);

async function savePage(db: Db, appSecret: string, workspaceId: string, page: fb.ListedPage) {
  await fb.subscribePage(page.id, page.access_token);
  const values = {
    workspaceId,
    pageId: page.id,
    name: page.name,
    pictureUrl: page.picture ?? null,
    accessTokenEnc: encryptSecret(appSecret, page.access_token),
    status: 'connected',
    statusDetail: null,
    updatedAt: new Date(),
  };
  await db
    .insert(facebookPages)
    .values(values)
    .onConflictDoUpdate({ target: facebookPages.pageId, set: values });
}

export const facebookPublicRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    /** Facebook Login comes back here: connect the one Page, or keep the list to pick from. */
    app.get('/facebook/callback', async (req, reply) => {
      const back = (params: Record<string, string>) =>
        reply.redirect(`/channels/facebook?${new URLSearchParams(params)}`);
      const q = z
        .object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        })
        .parse(req.query);
      if (q.error) return back({ error: q.error_description || 'Facebook login was cancelled.' });
      const state = q.state
        ? verifyToken<{ ws: string; u: string; ts: number }>(
            config.appSecret,
            q.state,
            STATE_MAX_AGE,
          )
        : null;
      if (!state || !q.code)
        return back({ error: 'That sign-in link expired. Click Connect Facebook again.' });
      if (req.workspace && req.workspace.id !== state.ws)
        return back({
          error: 'You’re signed in to a different workspace than the one that started this.',
        });
      const settings = await metaAppFor(db, state.ws);
      const appId = appIdOf(settings);
      const appSecret = decryptOptional(config.appSecret, settings.facebookAppSecretEnc);
      if (!appId || !appSecret)
        return back({ error: 'Save the Meta app ID and app secret first.' });
      try {
        const userToken = await fb.pageUserToken(
          appId,
          appSecret,
          facebookRedirect(config.publicUrl),
          q.code,
        );
        const pages = await fb.listPages(userToken);
        if (pages.length === 0)
          return back({
            error:
              'Facebook didn’t share any Pages. Log in again and choose at least one Page, or check that you manage one.',
          });
        if (pages.length === 1 && pages[0]) {
          await savePage(db, config.appSecret, state.ws, pages[0]);
          return back({ connected: pages[0].name });
        }
        await db
          .update(metaApps)
          .set({
            facebookPendingEnc: encryptSecret(config.appSecret, JSON.stringify(pages)),
            facebookPendingAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(metaApps.workspaceId, state.ws));
        return back({ choose: String(pages.length) });
      } catch (err) {
        req.log.warn({ err: String(err) }, 'facebook login failed');
        return back({
          error:
            err instanceof MetaError ? fb.facebookFriendly(err) : 'Facebook login didn’t finish.',
        });
      }
    });
  };

export const facebookRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    const pendingOf = (s: Awaited<ReturnType<typeof metaAppFor>>): Pending => {
      if (!s.facebookPendingEnc || !s.facebookPendingAt) return [];
      if (Date.now() - s.facebookPendingAt.getTime() > PENDING_MAX_AGE) return [];
      try {
        return JSON.parse(decryptOptional(config.appSecret, s.facebookPendingEnc) ?? '[]');
      } catch {
        return [];
      }
    };

    const status = async (workspaceId: string) => {
      const s = await metaAppFor(db, workspaceId);
      const pages = await db
        .select({
          id: facebookPages.id,
          pageId: facebookPages.pageId,
          name: facebookPages.name,
          pictureUrl: facebookPages.pictureUrl,
          status: facebookPages.status,
          statusDetail: facebookPages.statusDetail,
          connectedAt: facebookPages.connectedAt,
        })
        .from(facebookPages)
        .where(eq(facebookPages.workspaceId, workspaceId))
        .orderBy(asc(facebookPages.connectedAt));
      const connected = new Set(pages.map((p) => p.pageId));
      return {
        appId: appIdOf(s),
        /** Set on its own (not taken from the Instagram Login URL). */
        appIdSaved: Boolean(s.facebookAppId),
        configId: s.facebookConfigId,
        hasAppSecret: Boolean(s.facebookAppSecretEnc),
        urls: {
          oauthRedirect: facebookRedirect(config.publicUrl),
          webhook: metaUrls(config.publicUrl).webhook,
          privacy: metaUrls(config.publicUrl).privacy,
        },
        webhookVerifyToken: s.webhookVerifyToken,
        webhookVerifiedAt: s.webhookVerifiedAt,
        lastWebhookAt: s.lastWebhookAt,
        scopes: fb.PAGE_SCOPES,
        fields: fb.PAGE_FIELDS,
        pages,
        /** Pages from the last login, waiting to be picked (tokens stay on the server). */
        pending: pendingOf(s).map((p) => ({
          id: p.id,
          name: p.name,
          picture: p.picture ?? null,
          connected: connected.has(p.id),
        })),
      };
    };

    app.get('/facebook/settings', async (req) => status(who(req).workspace.id));

    app.put('/facebook/settings', async (req) => {
      const { workspace } = requireAdmin(req);
      const body = z
        .object({
          appId: z
            .string()
            .trim()
            .regex(/^\d{6,24}$/, 'The Meta app ID is a long number (App settings → Basic).')
            .nullable()
            .optional(),
          configId: z
            .string()
            .trim()
            .regex(/^\d{6,24}$/, 'The configuration ID is a long number.')
            .nullable()
            .optional(),
          /** The Meta app secret, if Instagram's setup hasn't saved it already. */
          appSecret: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9]{16,128}$/, 'That doesn’t look like an app secret.')
            .optional(),
        })
        .parse(req.body);
      await metaAppFor(db, workspace.id);
      await db
        .update(metaApps)
        .set({
          ...(body.appId !== undefined ? { facebookAppId: body.appId } : {}),
          ...(body.configId !== undefined ? { facebookConfigId: body.configId } : {}),
          ...(body.appSecret
            ? { facebookAppSecretEnc: encryptSecret(config.appSecret, body.appSecret) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(metaApps.workspaceId, workspace.id));
      return status(workspace.id);
    });

    /** Sends the browser to Facebook Login, which comes back to /api/facebook/callback. */
    app.get('/facebook/connect', async (req, reply) => {
      const { user, workspace } = requireAdmin(req);
      const s = await metaAppFor(db, workspace.id);
      const appId = appIdOf(s);
      if (!appId || !s.facebookAppSecretEnc)
        return reply.redirect(
          `/channels/facebook?${new URLSearchParams({ error: 'Save the Meta app ID and app secret first.' })}`,
        );
      const state = signToken(config.appSecret, { ws: workspace.id, u: user.id, ts: Date.now() });
      return reply.redirect(
        fb.pageAuthorizeUrl(appId, facebookRedirect(config.publicUrl), state, s.facebookConfigId),
      );
    });

    /** Connects the Pages picked from the last login. */
    app.post('/facebook/pages', async (req, reply) => {
      const { workspace } = requireAdmin(req);
      const { pageIds } = z
        .object({
          pageIds: z
            .array(z.string().regex(/^\d{1,30}$/))
            .min(1)
            .max(50),
        })
        .parse(req.body);
      const s = await metaAppFor(db, workspace.id);
      const pending = pendingOf(s);
      const chosen = pending.filter((p) => pageIds.includes(p.id));
      if (chosen.length === 0)
        return reply.code(409).send({ error: 'That list expired. Click Connect Facebook again.' });
      const failed: string[] = [];
      for (const page of chosen) {
        try {
          await savePage(db, config.appSecret, workspace.id, page);
        } catch (err) {
          req.log.warn({ err: String(err), page: page.id }, 'connecting a facebook page failed');
          failed.push(
            `${page.name}: ${err instanceof MetaError ? fb.facebookFriendly(err) : 'didn’t connect'}`,
          );
        }
      }
      if (failed.length < chosen.length)
        await db
          .update(metaApps)
          .set({ facebookPendingEnc: null, facebookPendingAt: null, updatedAt: new Date() })
          .where(eq(metaApps.workspaceId, workspace.id));
      return { ...(await status(workspace.id)), failed };
    });

    app.delete('/facebook/pages/:id', async (req) => {
      const { workspace } = requireAdmin(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [page] = await db
        .select()
        .from(facebookPages)
        .where(and(eq(facebookPages.id, id), eq(facebookPages.workspaceId, workspace.id)));
      if (!page) throw notFound('Page');
      const token = decryptOptional(config.appSecret, page.accessTokenEnc);
      if (token) await fb.unsubscribePage(page.pageId, token).catch(() => undefined);
      await db.delete(facebookPages).where(eq(facebookPages.id, id));
      return status(workspace.id);
    });

    /** Recent posts on the workspace's Pages, for comment triggers on specific posts. */
    app.get('/facebook/posts', async (req, reply) => {
      const { workspace } = who(req);
      const pages = await db
        .select()
        .from(facebookPages)
        .where(
          and(eq(facebookPages.workspaceId, workspace.id), eq(facebookPages.status, 'connected')),
        );
      if (pages.length === 0) return reply.code(409).send({ error: 'not_connected' });
      const posts = [];
      for (const page of pages) {
        const token = decryptOptional(config.appSecret, page.accessTokenEnc);
        if (!token) continue;
        try {
          for (const p of await fb.pagePosts(page.pageId, token))
            posts.push({ ...p, pageId: page.pageId, pageName: page.name });
        } catch (err) {
          req.log.warn({ err: String(err), page: page.pageId }, 'listing facebook posts failed');
        }
      }
      posts.sort((a, b) => (b.created_time ?? '').localeCompare(a.created_time ?? ''));
      return { posts };
    });
  };
