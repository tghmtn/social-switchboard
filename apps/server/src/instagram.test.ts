import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { instagramAccounts, messages, webhookEvents } from './db/schema';
import { toInstagramMessages } from './instagram/channel';
import { setHttp } from './instagram/graph';
import { refreshExpiringTokens } from './instagram/tokens';
import { signRequest } from './meta';

// The whole Instagram path against a fake Meta: settings, webhook verification, login, signed
// deliveries, comment → private reply → quick reply → DM, and token upkeep.

describe('toInstagramMessages', () => {
  const msg = {
    parts: [
      { type: 'text' as const, text: 'Hi there' },
      { type: 'image' as const, url: 'https://x.test/a.jpg' },
      { type: 'text' as const, text: 'Pick one' },
    ],
    buttons: [{ id: 'b1', kind: 'url' as const, label: 'Open', url: 'https://x.test' }],
    quickReplies: [{ id: 'q1', label: 'Yes' }],
  };

  it('sends parts in order, with buttons and quick replies on the last message', () => {
    expect(toInstagramMessages(msg, { q1: 'P1' }, false)).toEqual([
      { text: 'Hi there' },
      { attachment: { type: 'image', payload: { url: 'https://x.test/a.jpg' } } },
      {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: 'Pick one',
            buttons: [{ type: 'web_url', url: 'https://x.test', title: 'Open' }],
          },
        },
        quick_replies: [{ content_type: 'text', title: 'Yes', payload: 'P1' }],
      },
    ]);
  });

  it('collapses to one message for a private reply', () => {
    const out = toInstagramMessages({ ...msg, buttons: [] }, { q1: 'P1' }, true);
    expect(out).toEqual([
      {
        text: 'Hi there\n\nPick one',
        quick_replies: [{ content_type: 'text', title: 'Yes', payload: 'P1' }],
      },
    ]);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const IG_ID = '17841400000000001';
const IG_SECRET = 'a'.repeat(32);
const FB_SECRET = 'b'.repeat(32);

type Call = { method: string; url: URL; body: unknown };

describe.skipIf(!databaseUrl)('Instagram end to end (fake Meta)', () => {
  const config = {
    ...loadConfig({
      NODE_ENV: 'test',
      PUBLIC_URL: 'https://switchboard.example.test',
      GUIDE_UPDATES: 'off',
    }),
    databaseUrl: databaseUrl ?? '',
  };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;
  let cookies: Record<string, string> = {};
  let calls: Call[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fakeMeta: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body =
      typeof init?.body === 'string'
        ? JSON.parse(init.body)
        : init?.body
          ? Object.fromEntries(new URLSearchParams(String(init.body)))
          : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    if (url.host === 'api.instagram.com')
      return json({ access_token: 'short-token', user_id: Number(IG_ID) });
    if (path === '/access_token')
      return json({ access_token: 'long-token', expires_in: 5_184_000 });
    if (path === '/refresh_access_token')
      return json({ access_token: 'refreshed-token', expires_in: 5_184_000 });
    if (path === '/me')
      return json({ user_id: IG_ID, username: 'tgtest', account_type: 'MEDIA_CREATOR' });
    if (path.endsWith('/subscribed_apps')) return json({ success: true });
    if (path.endsWith('/messages'))
      return json({ recipient_id: 'x', message_id: `mid.${calls.length}` });
    if (path.endsWith('/replies')) return json({ id: 'reply-1' });
    if (path === '/fan-igsid') return json({ username: 'fan_account' });
    return json({ error: { message: `unexpected ${path}`, code: 100 } }, 400);
  };

  const call = async <T = unknown>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, payload, cookies });
    return {
      status: res.statusCode,
      headers: res.headers,
      body: (res.headers['content-type']?.includes('json') ? res.json() : res.body) as T,
    };
  };
  const webhook = (payload: object, secret = IG_SECRET) => {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/api/instagram/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
  };
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const r = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from webhook_events where processed_at is null`,
      );
      const queued = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from messages where status = 'queued'`,
      );
      if (r.rows[0]?.n === 0 && queued.rows[0]?.n === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('webhook events never finished processing');
  };
  const sends = () =>
    calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/messages'));

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    setHttp(fakeMeta);
    app = await buildApp({ db, config }, false);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    calls = [];
    await db.execute(sql`truncate workspaces, users, webhook_events cascade`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        firstName: 'Todd',
        email: 't@example.test',
        password: 'a long enough password',
        workspaceName: 'Test',
      },
    });
    const session = res.cookies.find((c) => c.name === 'ss_session');
    cookies = session ? { ss_session: session.value } : {};
  });

  async function connect() {
    await call('PUT', '/api/instagram/settings', {
      instagramAppId: '1234567890123456',
      instagramAppSecret: IG_SECRET,
      facebookAppSecret: FB_SECRET,
    });
    const start = await call('GET', '/api/instagram/connect');
    const location = new URL(String(start.headers.location));
    const back = await call(
      'GET',
      `/api/instagram/callback?code=abc&state=${encodeURIComponent(location.searchParams.get('state') ?? '')}`,
    );
    return { start: location, back: String(back.headers.location) };
  }

  it('saves settings without echoing secrets and verifies the webhook', async () => {
    const saved = await call<Record<string, unknown>>('PUT', '/api/instagram/settings', {
      instagramAppId: '1234567890123456',
      instagramAppSecret: IG_SECRET,
      facebookAppSecret: FB_SECRET,
    });
    expect(saved.body).toMatchObject({
      instagramAppId: '1234567890123456',
      hasInstagramAppSecret: true,
      hasFacebookAppSecret: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain(IG_SECRET);
    expect(saved.body.urls).toMatchObject({
      webhook: 'https://switchboard.example.test/api/instagram/webhook',
    });

    const token = String(saved.body.webhookVerifyToken);
    const bad = await app.inject({
      url: '/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123',
    });
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({
      url: `/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=123`,
    });
    expect(good.body).toBe('123');
    expect(
      (await call<{ webhookVerifiedAt: string | null }>('GET', '/api/instagram/settings')).body
        .webhookVerifiedAt,
    ).not.toBeNull();
  });

  it('connects an account through Instagram login', async () => {
    const { start, back } = await connect();
    expect(start.origin + start.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(start.searchParams.get('redirect_uri')).toBe(
      'https://switchboard.example.test/api/instagram/callback',
    );
    expect(back).toBe('/channels?connected=tgtest');
    const [account] = await db.select().from(instagramAccounts);
    expect(account).toMatchObject({
      igUserId: IG_ID,
      username: 'tgtest',
      accountType: 'MEDIA_CREATOR',
      status: 'connected',
    });
    expect(account?.accessTokenEnc).not.toContain('long-token');
    expect(calls.some((c) => c.url.pathname.endsWith(`/${IG_ID}/subscribed_apps`))).toBe(true);

    const expired = await call('GET', '/api/instagram/callback?code=abc&state=forged');
    expect(String(expired.headers.location)).toContain('error=');
  });

  it('rejects unsigned webhooks', async () => {
    await connect();
    const res = await webhook(
      { object: 'instagram', entry: [] },
      'wrong-secret-wrong-secret-wrong!',
    );
    expect(res.statusCode).toBe(401);
    expect(await db.select().from(webhookEvents)).toEqual([]);
  });

  it('turns a comment into a private reply, then continues in DMs', async () => {
    await connect();
    const { body } = await call<{ flow: { id: string } }>('POST', '/api/flows', {
      name: 'Workshop',
      starter: 'lead_magnet',
    });
    await call('POST', `/api/flows/${body.flow.id}/publish`, {});
    await call('POST', '/api/triggers', {
      flowId: body.flow.id,
      config: {
        type: 'comment',
        keywords: ['workshop'],
        match: 'contains',
        mediaIds: [],
        publicReplies: ['Check your DMs!'],
      },
    });
    calls = [];

    const comment = {
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          changes: [
            {
              field: 'comments',
              value: {
                id: 'c1',
                text: 'Workshop please!',
                from: { id: 'fan-igsid', username: 'fan_account' },
                media: { id: 'm1' },
              },
            },
          ],
        },
      ],
    };
    expect((await webhook(comment)).statusCode).toBe(200);
    await settled();

    const [first] = sends();
    expect(first?.body).toMatchObject({
      recipient: { comment_id: 'c1' },
      message: { text: expect.stringContaining('Hey there!') },
    });
    if (!first) throw new Error('no private reply was sent');
    const quick = (
      first.body as { message: { quick_replies: { title: string; payload: string }[] } }
    ).message.quick_replies;
    expect(quick.map((q) => q.title)).toEqual(['Getting started', 'Advanced']);
    expect(calls.find((c) => c.url.pathname.endsWith('/c1/replies'))?.body).toEqual({
      message: 'Check your DMs!',
    });

    // They tap a quick reply: a normal DM now, inside the 24-hour window.
    const tap = {
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          messaging: [
            {
              sender: { id: 'fan-igsid' },
              recipient: { id: IG_ID },
              message: {
                mid: 'in-1',
                text: 'Advanced',
                quick_reply: { payload: quick[1]?.payload },
              },
            },
          ],
        },
      ],
    };
    await webhook(tap);
    await settled();
    const second = sends()[1];
    expect(second?.body).toMatchObject({
      recipient: { id: 'fan-igsid' },
      message: { text: expect.stringContaining('Want the free worksheet?') },
    });

    const contacts = await call<{ contacts: { username: string; tags: string[] }[] }>(
      'GET',
      '/api/contacts',
    );
    expect(contacts.body.contacts[0]).toMatchObject({
      username: 'fan_account',
      tags: ['workshop-interest'],
    });

    // Our own account commenting is ignored.
    calls = [];
    await webhook({
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          changes: [
            {
              field: 'comments',
              value: { id: 'c2', text: 'workshop', from: { id: IG_ID }, media: { id: 'm1' } },
            },
          ],
        },
      ],
    });
    await settled();
    expect(sends()).toEqual([]);
  });

  it('holds a second message after a comment until the person writes back', async () => {
    await connect();
    const { body } = await call<{ flow: { id: string } }>('POST', '/api/flows', {
      name: 'Two messages',
      starter: 'blank',
    });
    await call('PUT', `/api/flows/${body.flow.id}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'a', type: 'message', data: { parts: [{ type: 'text', text: 'First' }] } },
          { id: 'b', type: 'message', data: { parts: [{ type: 'text', text: 'Second' }] } },
        ],
        edges: [
          { id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' },
          { id: 'e2', source: 'a', sourceHandle: 'next', target: 'b' },
        ],
      },
    });
    await call('POST', `/api/flows/${body.flow.id}/publish`, {});
    await call('POST', '/api/triggers', { flowId: body.flow.id, config: { type: 'comment' } });
    calls = [];

    await webhook({
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          changes: [
            {
              field: 'comments',
              value: { id: 'c9', text: 'hello', from: { id: 'fan-igsid' }, media: { id: 'm1' } },
            },
          ],
        },
      ],
    });
    await settled();
    expect(sends().map((c) => c.body)).toEqual([
      { recipient: { comment_id: 'c9' }, message: { text: 'First' } },
    ]);
    const held = await db
      .select({ status: messages.status, error: messages.error })
      .from(messages)
      .where(eq(messages.status, 'blocked'));
    expect(held).toEqual([
      { status: 'blocked', error: expect.stringContaining('one reply to a comment') },
    ]);
  });

  it('marks an account disconnected when the app is removed, and refreshes tokens', async () => {
    await connect();
    await db.update(instagramAccounts).set({
      tokenExpiresAt: new Date(Date.now() + 5 * 86_400_000),
      updatedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    expect(await refreshExpiringTokens(db, config.appSecret)).toBe(1);
    expect(calls.some((c) => c.url.pathname.endsWith('/refresh_access_token'))).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/instagram/deauthorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(signRequest({ algorithm: 'HMAC-SHA256', user_id: IG_ID }, IG_SECRET))}`,
    });
    expect(res.statusCode).toBe(200);
    const [account] = await db.select().from(instagramAccounts);
    expect(account?.status).toBe('disconnected');
  });

  it('serves the bundled setup guide', async () => {
    const res = await call<{ markdown: string; source: string }>(
      'GET',
      '/api/guides/connect-instagram',
    );
    expect(res.body.source).toBe('bundled');
    expect(res.body.markdown).toMatch(/## step: webhooks \|/);
  });
});
