import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { encryptSecret, signToken, verifyToken } from '../crypto';
import type { Db } from '../db/client';
import { instagramAccounts, messages, metaApps, webhookEvents } from '../db/schema';
import { processWebhookEvents } from '../instagram/events';
import * as graph from '../instagram/graph';
import { accountFor, decryptOptional, metaAppFor, metaSecrets } from '../instagram/settings';
import { parseSignedRequestAny } from '../meta';
import { notFound, requireWorkspace, who } from './guard';

// Instagram: the Meta app settings the wizard collects, the login hand-off, the webhook Meta calls,
// and the data the builder needs (connected accounts, recent posts).

const rawBodies = new WeakMap<FastifyRequest, string>();
const STATE_MAX_AGE = 15 * 60 * 1000;

/** Where things live for this install; the wizard shows these to paste into Meta. */
export const metaUrls = (publicUrl: string) => ({
  oauthRedirect: `${publicUrl}/api/instagram/callback`,
  deauthorize: `${publicUrl}/api/instagram/deauthorize`,
  dataDeletion: `${publicUrl}/api/meta/data-deletion`,
  webhook: `${publicUrl}/api/instagram/webhook`,
  privacy: `${publicUrl}/privacy`,
  terms: `${publicUrl}/terms`,
});

function signatureMatches(raw: string, header: string | undefined, secret: string) {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type NewAccount = {
  igUserId: string;
  username?: string;
  name?: string;
  profilePictureUrl?: string;
  accountType?: string;
  apiHost: graph.Host;
  token: string;
  expiresIn?: number;
};

/**
 * Saves (or refreshes) one connected account, then asks Meta to send us its events. Returns what
 * to tell the person instead when the account belongs to another workspace.
 */
async function saveAccount(db: Db, appSecret: string, workspaceId: string, a: NewAccount) {
  const [owner] = await db
    .select({ ws: instagramAccounts.workspaceId })
    .from(instagramAccounts)
    .where(eq(instagramAccounts.igUserId, a.igUserId));
  if (owner && owner.ws !== workspaceId)
    return `@${a.username ?? a.igUserId} is already connected to another workspace.`;
  const values = {
    workspaceId,
    igUserId: a.igUserId,
    username: a.username ?? null,
    name: a.name ?? null,
    profilePictureUrl: a.profilePictureUrl ?? null,
    accountType: a.accountType ?? null,
    apiHost: a.apiHost,
    accessTokenEnc: encryptSecret(appSecret, a.token),
    tokenExpiresAt: a.expiresIn ? new Date(Date.now() + a.expiresIn * 1000) : null,
    status: 'connected',
    statusDetail: null,
    updatedAt: new Date(),
  };
  await db
    .insert(instagramAccounts)
    .values(values)
    .onConflictDoUpdate({ target: instagramAccounts.igUserId, set: values });
  try {
    await graph.subscribe(a.igUserId, a.token, a.apiHost);
  } catch (err) {
    await db
      .update(instagramAccounts)
      .set({
        statusDetail: `Connected, but subscribing to its events failed: ${err instanceof graph.MetaError ? err.friendly : String(err)}`,
      })
      .where(eq(instagramAccounts.igUserId, a.igUserId));
  }
  return undefined;
}

/** How long a Unified login token waits for its account ID before Connect has to start over. */
const PENDING_MAX_AGE = 60 * 60 * 1000;

/** Routes Meta calls directly (no session): webhook, deauthorize, and the login callback. */
export const instagramPublicRoutes =
  ({ db, config, runtime }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    // Webhook signatures cover the exact bytes Meta sent, so keep the raw body (this plugin only).
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      rawBodies.set(req, String(body));
      try {
        done(null, JSON.parse(String(body)));
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

    const process = () =>
      void processWebhookEvents({ db, runtime, appSecret: config.appSecret }).catch((err) =>
        runtime.log?.('webhook processing failed', { error: String(err) }),
      );

    /** Meta checks the webhook URL by asking us to echo a challenge back with our verify token. */
    /** Asks Meta to send each connected account's events to this app. Safe to repeat. */
    const subscribeConnected = async (workspaceId: string) => {
      const accounts = await db
        .select()
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.workspaceId, workspaceId),
            eq(instagramAccounts.status, 'connected'),
          ),
        );
      for (const a of accounts) {
        const token = decryptOptional(config.appSecret, a.accessTokenEnc);
        if (!token) continue;
        await graph.subscribe(
          a.igUserId,
          token,
          a.apiHost === 'facebook' ? 'facebook' : 'instagram',
        );
        if (a.statusDetail?.startsWith('Connected, but subscribing')) {
          await db
            .update(instagramAccounts)
            .set({ statusDetail: null })
            .where(eq(instagramAccounts.id, a.id));
        }
      }
    };

    app.get('/instagram/webhook', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (q['hub.mode'] !== 'subscribe' || !q['hub.verify_token'] || !q['hub.challenge'])
        return reply.code(400).send('bad request');
      const [row] = await db
        .update(metaApps)
        .set({ webhookVerifiedAt: new Date() })
        .where(eq(metaApps.webhookVerifyToken, q['hub.verify_token']))
        .returning({ workspaceId: metaApps.workspaceId });
      if (!row) return reply.code(403).send('verify token does not match');
      // Accounts connected before webhooks were set up: switch their events on now.
      void subscribeConnected(row.workspaceId).catch((err) =>
        req.log.warn(
          { err: String(err) },
          'subscribing accounts after webhook verification failed',
        ),
      );
      return reply.type('text/plain').send(q['hub.challenge']);
    });

    /** Events from Instagram: stored first, answered fast, processed right after. */
    app.post('/instagram/webhook', async (req, reply) => {
      const raw = rawBodies.get(req) ?? '';
      const signature = req.headers['x-hub-signature-256'];
      const secrets = await metaSecrets(db, config.appSecret, config.metaAppSecret);
      if (secrets.length === 0) return reply.code(503).send({ error: 'meta_not_configured' });
      const matched = secrets.filter((s) =>
        signatureMatches(raw, typeof signature === 'string' ? signature : undefined, s.secret),
      );
      if (matched.length === 0) {
        req.log.warn('instagram webhook with a bad signature');
        return reply.code(401).send({ error: 'bad_signature' });
      }
      await db.insert(webhookEvents).values({ source: 'instagram', payload: req.body });
      const workspaceIds = matched.flatMap((m) => (m.workspaceId ? [m.workspaceId] : []));
      if (workspaceIds.length > 0)
        await db
          .update(metaApps)
          .set({ lastWebhookAt: new Date() })
          .where(inArray(metaApps.workspaceId, workspaceIds));
      setImmediate(process);
      return reply.code(200).send('EVENT_RECEIVED');
    });

    /** Someone removed our app in their Instagram settings. */
    app.post('/instagram/deauthorize', async (req, reply) => {
      const secrets = (await metaSecrets(db, config.appSecret, config.metaAppSecret)).map(
        (s) => s.secret,
      );
      const signed = z
        .object({ signed_request: z.string().min(10).max(10_000) })
        .safeParse(req.body);
      const data = signed.success
        ? parseSignedRequestAny(signed.data.signed_request, secrets)
        : null;
      if (!data?.user_id) return reply.code(400).send({ error: 'invalid_signed_request' });
      await db
        .update(instagramAccounts)
        .set({
          status: 'disconnected',
          statusDetail: 'The app was removed in Instagram’s settings.',
          updatedAt: new Date(),
        })
        .where(eq(instagramAccounts.igUserId, String(data.user_id)));
      return { ok: true };
    });

    /** Instagram sends the person back here after they approve the connection. */
    app.get('/instagram/callback', async (req, reply) => {
      const back = (params: Record<string, string>) =>
        reply.redirect(`/channels?${new URLSearchParams(params)}`);
      const q = z
        .object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        })
        .parse(req.query);
      if (q.error) return back({ error: q.error_description || 'Instagram login was cancelled.' });
      const state = q.state
        ? verifyToken<{ ws: string; u: string; m?: 'u' | 'i'; ts: number }>(
            config.appSecret,
            q.state,
            STATE_MAX_AGE,
          )
        : null;
      if (!state || !q.code)
        return back({ error: 'That sign-in link expired. Click Connect Instagram again.' });
      if (req.workspace && req.workspace.id !== state.ws)
        return back({
          error: 'You’re signed in to a different workspace than the one that started this.',
        });

      const settings = await metaAppFor(db, state.ws);
      const redirect = metaUrls(config.publicUrl).oauthRedirect;
      const save = (a: NewAccount) => saveAccount(db, config.appSecret, state.ws, a);

      try {
        // Unified login (newer Meta apps): a business system-user token for the accounts the person shared.
        if (state.m === 'u') {
          const metaAppId = settings.loginUrl
            ? new URL(settings.loginUrl).searchParams.get('client_id')
            : null;
          const metaAppSecret = decryptOptional(config.appSecret, settings.facebookAppSecretEnc);
          if (!metaAppId || !metaAppSecret)
            return back({ error: 'Paste your Login URL and Meta app secret first.' });
          const token = await graph.exchangeUnifiedCode(metaAppId, metaAppSecret, redirect, q.code);
          const { accounts, notes } = await graph.findInstagramAccounts(
            token.accessToken,
            metaAppId,
            metaAppSecret,
          );
          req.log.info(
            { notes, found: accounts.length },
            'unified login: looked for Instagram accounts',
          );
          // Meta often doesn't say which account was shared (its token lists none without
          // business_management), so keep the token and ask for the ID Meta shows the owner.
          await db
            .update(metaApps)
            .set(
              accounts.length === 0
                ? {
                    pendingTokenEnc: encryptSecret(config.appSecret, token.accessToken),
                    pendingTokenAt: new Date(),
                  }
                : { pendingTokenEnc: null, pendingTokenAt: null },
            )
            .where(eq(metaApps.workspaceId, state.ws));
          if (accounts.length === 0) return back({ account: 'needed' });
          const problems: string[] = [];
          for (const a of accounts) {
            const problem = await save({
              igUserId: a.id,
              username: a.username,
              name: a.name,
              profilePictureUrl: a.profile_picture_url,
              apiHost: 'facebook',
              token: token.accessToken,
              expiresIn: token.expiresIn,
            });
            if (problem) problems.push(problem);
          }
          if (problems.length === accounts.length) return back({ error: problems.join(' ') });
          return back({ connected: accounts.map((a) => a.username ?? a.id).join(', @') });
        }

        // Instagram login (older apps): instagram.com OAuth and a 60-day user token.
        const appSecret = decryptOptional(config.appSecret, settings.instagramAppSecretEnc);
        if (!settings.instagramAppId || !appSecret)
          return back({ error: 'Add your Instagram app ID and secret first.' });
        const short = await graph.exchangeCode(
          settings.instagramAppId,
          appSecret,
          redirect,
          q.code,
        );
        const long = await graph.longLivedToken(appSecret, short.accessToken);
        const profile = await graph.me(long.accessToken);
        if (profile.account_type && !['BUSINESS', 'MEDIA_CREATOR'].includes(profile.account_type)) {
          return back({
            error: `@${profile.username ?? 'that account'} is a personal account. Switch it to Creator or Business (step 1) and try again.`,
          });
        }
        const problem = await save({
          igUserId: String(profile.user_id ?? short.userId),
          username: profile.username,
          name: profile.name,
          profilePictureUrl: profile.profile_picture_url,
          accountType: profile.account_type,
          apiHost: 'instagram',
          token: long.accessToken,
          expiresIn: long.expiresIn,
        });
        if (problem) return back({ error: problem });
        return back({ connected: profile.username ?? String(profile.user_id ?? short.userId) });
      } catch (err) {
        req.log.warn({ err: String(err) }, 'instagram connect failed');
        return back({
          error:
            err instanceof graph.MetaError
              ? err.friendly
              : 'Connecting failed. Try again in a minute.',
        });
      }
    });
  };

const guideCache = new Map<string, { at: number; markdown: string }>();
const GUIDE_TTL = 60 * 60 * 1000;
const GUIDES = new Set(['connect-instagram']);

/** Routes the wizard and builder use (signed in). */
export const instagramRoutes =
  ({ db, config }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireWorkspace);

    const status = async (workspaceId: string) => {
      const s = await metaAppFor(db, workspaceId);
      const accounts = await db
        .select({
          id: instagramAccounts.id,
          igUserId: instagramAccounts.igUserId,
          username: instagramAccounts.username,
          name: instagramAccounts.name,
          profilePictureUrl: instagramAccounts.profilePictureUrl,
          accountType: instagramAccounts.accountType,
          status: instagramAccounts.status,
          statusDetail: instagramAccounts.statusDetail,
          tokenExpiresAt: instagramAccounts.tokenExpiresAt,
          connectedAt: instagramAccounts.connectedAt,
        })
        .from(instagramAccounts)
        .where(eq(instagramAccounts.workspaceId, workspaceId));
      const [sent] = await db
        .select({ at: max(messages.sentAt) })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, workspaceId),
            eq(messages.channel, 'instagram'),
            eq(messages.direction, 'out'),
            eq(messages.status, 'sent'),
            sql`${messages.content} ->> 'byPerson' is null`,
          ),
        );
      const login = s.loginUrl ? new URL(s.loginUrl) : undefined;
      return {
        publicUrl: config.publicUrl,
        isPublic: config.publicUrl.startsWith('https://'),
        urls: metaUrls(config.publicUrl),
        loginMode: s.loginUrl ? 'unified' : s.instagramAppId ? 'instagram' : null,
        loginUrl: s.loginUrl,
        metaAppId: login?.searchParams.get('client_id') ?? null,
        configId: login?.searchParams.get('config_id') ?? null,
        /** False when the Login URL was made for a different redirect than this install's. */
        loginRedirectMatches: login?.searchParams.has('redirect_uri')
          ? login.searchParams.get('redirect_uri') === metaUrls(config.publicUrl).oauthRedirect
          : null,
        instagramAppId: s.instagramAppId,
        hasInstagramAppSecret: Boolean(s.instagramAppSecretEnc),
        hasFacebookAppSecret: Boolean(s.facebookAppSecretEnc),
        /** Unified login finished but Meta didn't say which account: its ID finishes connecting. */
        accountIdNeeded: Boolean(
          s.pendingTokenEnc &&
            s.pendingTokenAt &&
            Date.now() - s.pendingTokenAt.getTime() < PENDING_MAX_AGE,
        ),
        webhookVerifyToken: s.webhookVerifyToken,
        webhookVerifiedAt: s.webhookVerifiedAt,
        lastWebhookAt: s.lastWebhookAt,
        /** Last DM Instagram accepted from us: proves the account allows messages from apps. */
        lastSentAt: sent?.at ?? null,
        accounts,
      };
    };

    app.get('/instagram/settings', async (req) => status(who(req).workspace.id));

    app.put('/instagram/settings', async (req) => {
      const { workspace } = who(req);
      const secret = z
        .string()
        .trim()
        .regex(
          /^[A-Za-z0-9]{16,128}$/,
          'That doesn’t look like an app secret (letters and numbers, usually 32).',
        );
      const body = z
        .object({
          instagramAppId: z
            .string()
            .trim()
            .regex(/^\d{6,24}$/, 'The Instagram app ID is a long number.')
            .optional(),
          instagramAppSecret: secret.optional(),
          facebookAppSecret: secret.optional(),
          loginUrl: z
            .url()
            .refine((u) => {
              const url = new URL(u);
              return (
                /(^|\.)facebook\.com$/.test(url.hostname) &&
                url.searchParams.has('client_id') &&
                url.searchParams.has('config_id')
              );
            }, 'Paste the Login URL Meta shows under your configuration. It starts with https://www.facebook.com/ and contains config_id.')
            .optional(),
        })
        .parse(req.body);
      await metaAppFor(db, workspace.id);
      await db
        .update(metaApps)
        .set({
          ...(body.loginUrl ? { loginUrl: body.loginUrl } : {}),
          ...(body.instagramAppId ? { instagramAppId: body.instagramAppId } : {}),
          ...(body.instagramAppSecret
            ? { instagramAppSecretEnc: encryptSecret(config.appSecret, body.instagramAppSecret) }
            : {}),
          ...(body.facebookAppSecret
            ? { facebookAppSecretEnc: encryptSecret(config.appSecret, body.facebookAppSecret) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(metaApps.workspaceId, workspace.id));
      return status(workspace.id);
    });

    /** Sends the browser to Instagram's login, which comes back to /api/instagram/callback. */
    app.get('/instagram/connect', async (req, reply) => {
      const { user, workspace } = who(req);
      const s = await metaAppFor(db, workspace.id);
      const redirect = metaUrls(config.publicUrl).oauthRedirect;
      if (s.loginUrl && s.facebookAppSecretEnc) {
        const state = signToken(config.appSecret, {
          ws: workspace.id,
          u: user.id,
          m: 'u',
          ts: Date.now(),
        });
        return reply.redirect(graph.unifiedAuthorizeUrl(s.loginUrl, redirect, state));
      }
      if (s.instagramAppId && s.instagramAppSecretEnc) {
        const state = signToken(config.appSecret, {
          ws: workspace.id,
          u: user.id,
          m: 'i',
          ts: Date.now(),
        });
        return reply.redirect(graph.authorizeUrl(s.instagramAppId, redirect, state));
      }
      return reply.redirect(
        `/channels?${new URLSearchParams({ error: 'Paste your Login URL and Meta app secret first.' })}`,
      );
    });

    /** Finishes a Unified login with the account ID from Meta's Connected apps screen. */
    app.post('/instagram/accounts/by-id', async (req, reply) => {
      const { workspace } = who(req);
      const { igUserId } = z
        .object({
          igUserId: z
            .string()
            .trim()
            .regex(/^\d{5,30}$/, 'The account ID is a long number, like 17841400000000000.'),
        })
        .parse(req.body);
      const s = await metaAppFor(db, workspace.id);
      const fresh = s.pendingTokenAt && Date.now() - s.pendingTokenAt.getTime() < PENDING_MAX_AGE;
      const token = fresh ? decryptOptional(config.appSecret, s.pendingTokenEnc) : undefined;
      if (!token) return reply.code(409).send({ error: 'login_needed' });
      let account: graph.AssignedAccount;
      try {
        // Only works for an account the login shared, so a wrong or someone else's ID fails here.
        account = await graph.instagramAccount(token, igUserId);
      } catch (err) {
        req.log.info({ err: String(err) }, 'instagram account by id: not shared');
        return reply.code(400).send({ error: 'not_shared' });
      }
      const problem = await saveAccount(db, config.appSecret, workspace.id, {
        igUserId: account.id,
        username: account.username,
        name: account.name,
        profilePictureUrl: account.profile_picture_url,
        apiHost: 'facebook',
        token,
      });
      if (problem) return reply.code(409).send({ error: 'other_workspace' });
      await db
        .update(metaApps)
        .set({ pendingTokenEnc: null, pendingTokenAt: null })
        .where(eq(metaApps.workspaceId, workspace.id));
      return status(workspace.id);
    });

    app.delete('/instagram/accounts/:id', async (req, reply) => {
      const { workspace } = who(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const removed = await db
        .delete(instagramAccounts)
        .where(and(eq(instagramAccounts.id, id), eq(instagramAccounts.workspaceId, workspace.id)))
        .returning({ id: instagramAccounts.id });
      if (removed.length === 0) throw notFound('Account');
      return reply.code(204).send();
    });

    /** For the builder: will Instagram send this file link as a document, or as a link button? */
    app.post('/instagram/check-file', async (req) => {
      who(req);
      const { url } = z.object({ url: z.string().trim().min(1).max(2000) }).parse(req.body);
      return graph.checkFileUrl(url);
    });

    /** Recent posts, for picking which post a comment trigger watches. `after` pages back. */
    app.get('/instagram/media', async (req, reply) => {
      const { workspace } = who(req);
      const { after } = z.object({ after: z.string().max(500).optional() }).parse(req.query);
      const account = await accountFor(db, workspace.id, null);
      const token = account ? decryptOptional(config.appSecret, account.accessTokenEnc) : undefined;
      if (!account || !token) return reply.code(409).send({ error: 'not_connected' });
      try {
        const page = await graph.recentMedia(
          token,
          account.apiHost === 'facebook' ? 'facebook' : 'instagram',
          account.igUserId,
          after,
        );
        return {
          after: page.after,
          media: page.media.map((m) => ({
            id: m.id,
            caption: m.caption?.slice(0, 140) ?? '',
            kind:
              m.media_product_type === 'REELS' ? 'reel' : (m.media_type?.toLowerCase() ?? 'post'),
            thumbnail: m.thumbnail_url ?? (m.media_type === 'VIDEO' ? undefined : m.media_url),
            permalink: m.permalink,
            timestamp: m.timestamp,
          })),
        };
      } catch (err) {
        return reply.code(502).send({
          error: err instanceof graph.MetaError ? err.friendly : 'Instagram didn’t answer.',
        });
      }
    });

    /**
     * Setup guides: the latest copy from the project's repo (so a fix for a moved Meta button
     * reaches every install), falling back to the copy bundled with this version.
     */
    app.get('/guides/:name', async (req, reply) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      if (!GUIDES.has(name)) throw notFound('Guide');
      const bundled = () => readFile(join(config.guidesDir, `${name}.md`), 'utf8');
      if (!config.guideUpdates) return { markdown: await bundled(), source: 'bundled' };

      const cached = guideCache.get(name);
      if (cached && Date.now() - cached.at < GUIDE_TTL)
        return { markdown: cached.markdown, source: 'latest' };
      try {
        const res = await fetch(`${config.guideBaseUrl}/${name}.md`, {
          signal: AbortSignal.timeout(3000),
        });
        const text = res.ok ? await res.text() : '';
        // Only trust something that looks like one of our guides.
        if (text.length > 0 && text.length < 200_000 && /^## step:/m.test(text)) {
          guideCache.set(name, { at: Date.now(), markdown: text });
          return { markdown: text, source: 'latest' };
        }
      } catch {
        // offline or blocked: use the bundled copy
      }
      return reply.send({ markdown: await bundled(), source: 'bundled' });
    });
  };
