import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { instagramAccounts, messages, webhookEvents } from './db/schema';
import { toInstagramMessages } from './instagram/channel';
import { isPdfUrl, setHttp } from './instagram/graph';
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

describe('files on Instagram', () => {
  const guide = { type: 'file' as const, url: 'https://x.test/share', name: 'Guide.pdf' };
  const text = { type: 'text' as const, text: 'Here’s the guide 👇' };
  const open = (url: string) => ({ id: 'b1', kind: 'url' as const, label: 'Get the guide', url });
  const template = (buttons: object[], body = text.text) => ({
    attachment: { type: 'template', payload: { template_type: 'button', text: body, buttons } },
  });

  it('shows a file as a button in a private reply, never twice', () => {
    const msg = { parts: [text, guide], buttons: [open(guide.url)], quickReplies: [] };
    expect(toInstagramMessages(msg, {}, true)).toEqual([
      template([{ type: 'web_url', url: guide.url, title: 'Get the guide' }]),
    ]);
    const other = { ...msg, buttons: [open('https://x.test/elsewhere')] };
    expect(toInstagramMessages(other, {}, true)).toEqual([
      template([
        { type: 'web_url', url: 'https://x.test/elsewhere', title: 'Get the guide' },
        { type: 'web_url', url: guide.url, title: '📄 Guide.pdf' },
      ]),
    ]);
  });

  it('sends a PDF as a document, in order', () => {
    const msg = { parts: [text, guide], buttons: [], quickReplies: [] };
    expect(toInstagramMessages(msg, {}, false, new Set([guide.url]))).toEqual([
      { text: text.text },
      { attachment: { type: 'file', payload: { url: guide.url } } },
    ]);
  });

  it('keeps a file’s link out of the card when the buttons are full', () => {
    const postback = (id: string) => ({ id, kind: 'flow' as const, label: id });
    const msg = {
      parts: [text, guide],
      buttons: [postback('a'), postback('b'), postback('c')],
      quickReplies: [],
    };
    const out = toInstagramMessages(msg, {}, false);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ attachment: { payload: { text: text.text } } });
    expect(out[1]).toEqual({ text: `📄 Guide.pdf: ${guide.url}` });
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
  let assignedEmpty = false;
  let targetsEmpty = false;
  let messagesOff = false;
  let setups = 0;
  /** Sends wait on this, to hold a delivery mid-way. */
  let hold: Promise<void> = Promise.resolve();

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
    if (url.host === 'cdn.example.test')
      return new Response('fake-jpeg', { headers: { 'content-type': 'image/jpeg' } });
    if (url.host === 'files.example.test')
      return new Response(null, {
        headers: { 'content-type': path.endsWith('.pdf') ? 'application/pdf' : 'text/html' },
      });
    if (url.host === 'graph.facebook.com') {
      if (path === '/oauth/access_token') return json({ access_token: 'system-user-token' });
      if (path === '/me/assigned_instagram_accounts')
        return json({
          data: assignedEmpty ? [] : [{ id: IG_ID, username: 'tgunified', name: 'TG' }],
        });
      if (path === '/debug_token')
        return json({
          data: {
            granular_scopes: [
              targetsEmpty
                ? { scope: 'instagram_basic' }
                : { scope: 'instagram_basic', target_ids: [IG_ID] },
            ],
          },
        });
      if (path === `/${IG_ID}`) return json({ id: IG_ID, username: 'tgfromdebug' });
      if (path === `/${IG_ID}/media`)
        return url.searchParams.get('after') === 'c1'
          ? json({ data: [{ id: 'm2', media_type: 'IMAGE', media_url: 'y' }] })
          : json({
              data: [{ id: 'm1', media_type: 'IMAGE', caption: 'Hi', media_url: 'x' }],
              paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/next' },
            });
    }
    if (url.host === 'api.instagram.com')
      return json({ access_token: 'short-token', user_id: Number(IG_ID) });
    if (path === '/access_token')
      return json({ access_token: 'long-token', expires_in: 5_184_000 });
    if (path === '/refresh_access_token')
      return json({ access_token: 'refreshed-token', expires_in: 5_184_000 });
    if (path === '/me')
      return json({ user_id: IG_ID, username: 'tgtest', account_type: 'MEDIA_CREATOR' });
    if (path.endsWith('/subscribed_apps')) return json({ success: true });
    if (path.endsWith('/messages')) await hold;
    if (path.endsWith('/messages'))
      return messagesOff
        ? json(
            {
              error: {
                message:
                  'The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.',
                code: 200,
              },
            },
            400,
          )
        : json({ recipient_id: 'x', message_id: `mid.${calls.length}` });
    if (path.endsWith('/replies')) return json({ id: 'reply-1' });
    if (path === '/fan-igsid')
      return json({
        username: 'fan_account',
        name: 'Fan Person',
        profile_pic: 'https://cdn.example.test/fan.jpg',
        follower_count: 12,
        is_user_follow_business: true,
        is_business_follow_user: false,
      });
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
    assignedEmpty = false;
    targetsEmpty = false;
    messagesOff = false;
    hold = Promise.resolve();
    await db.execute(sql`truncate workspaces, users, webhook_events cascade`);
    // Each test signs up a fresh owner; a new LAN address per test keeps under setup's rate limit.
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: `10.0.0.${++setups}`,
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

  it('connects through Unified login and talks to graph.facebook.com', async () => {
    const loginUrl =
      'https://www.facebook.com/dialog/oauth?client_id=1076000000000001&config_id=2900000000000001&display=popup&redirect_uri=https%3A%2F%2Fswitchboard.example.test%2Fapi%2Finstagram%2Fcallback&response_type=code';
    const wrong = await call('PUT', '/api/instagram/settings', {
      loginUrl: 'https://evil.example.test/dialog/oauth?client_id=1&config_id=2',
    });
    expect(wrong.status).toBe(400);
    const saved = await call<Record<string, unknown>>('PUT', '/api/instagram/settings', {
      loginUrl,
      facebookAppSecret: FB_SECRET,
    });
    expect(saved.body).toMatchObject({
      loginMode: 'unified',
      metaAppId: '1076000000000001',
      configId: '2900000000000001',
      loginRedirectMatches: true,
      hasFacebookAppSecret: true,
    });

    const start = new URL(String((await call('GET', '/api/instagram/connect')).headers.location));
    expect(start.origin + start.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(start.searchParams.get('config_id')).toBe('2900000000000001');
    expect(start.searchParams.get('display')).toBe('page');
    const back = await call(
      'GET',
      `/api/instagram/callback?code=abc&state=${encodeURIComponent(start.searchParams.get('state') ?? '')}`,
    );
    expect(String(back.headers.location)).toBe('/channels?connected=tgunified');

    const exchange = calls.find((c) => c.url.pathname.endsWith('/oauth/access_token'));
    expect(exchange?.url.searchParams.get('client_id')).toBe('1076000000000001');
    expect(exchange?.url.searchParams.get('client_secret')).toBe(FB_SECRET);
    const [account] = await db.select().from(instagramAccounts);
    expect(account).toMatchObject({ igUserId: IG_ID, username: 'tgunified', apiHost: 'facebook' });
    expect(account?.tokenExpiresAt).toBeNull();
    const subscribe = calls.find((c) => c.url.pathname.endsWith(`/${IG_ID}/subscribed_apps`));
    expect(subscribe?.url.host).toBe('graph.facebook.com');
    expect(subscribe?.body).toMatchObject({
      subscribed_fields: expect.stringContaining('comments'),
    });

    // Webhooks set up after connecting (Meta's own order): verifying them re-subscribes the account.
    calls = [];
    const verify = await app.inject({
      url: `/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=${saved.body.webhookVerifyToken}&hub.challenge=7`,
    });
    expect(verify.body).toBe('7');
    for (let i = 0; i < 50 && !calls.some((c) => c.url.pathname.endsWith('/subscribed_apps')); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.find((c) => c.url.pathname.endsWith('/subscribed_apps'))?.url.host).toBe(
      'graph.facebook.com',
    );

    const media = await call<{ media: { id: string }[]; after?: string }>(
      'GET',
      '/api/instagram/media',
    );
    expect(media.body.media.map((m) => m.id)).toEqual(['m1']);
    // Older posts, one page back; the last page has nothing further.
    const older = await call<{ media: { id: string }[]; after?: string }>(
      'GET',
      `/api/instagram/media?after=${media.body.after}`,
    );
    expect(older.body.media.map((m) => m.id)).toEqual(['m2']);
    expect(older.body.after).toBeUndefined();

    // A comment signed with the Meta app secret becomes a private reply through graph.facebook.com.
    const { body } = await call<{ flow: { id: string } }>('POST', '/api/flows', {
      name: 'Hello',
      starter: 'blank',
    });
    await call('PUT', `/api/flows/${body.flow.id}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'a', type: 'message', data: { parts: [{ type: 'text', text: 'Hi!' }] } },
        ],
        edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' }],
      },
    });
    await call('POST', `/api/flows/${body.flow.id}/publish`, {});
    await call('POST', '/api/triggers', { flowId: body.flow.id, config: { type: 'comment' } });
    calls = [];
    const res = await webhook(
      {
        object: 'instagram',
        entry: [
          {
            id: IG_ID,
            changes: [
              {
                field: 'comments',
                value: { id: 'c5', text: 'hi', from: { id: 'fan-igsid' }, media: { id: 'm1' } },
              },
            ],
          },
        ],
      },
      FB_SECRET,
    );
    expect(res.statusCode).toBe(200);
    await settled();
    const [sent] = sends();
    expect(sent?.url.host).toBe('graph.facebook.com');
    expect(sent?.url.pathname).toMatch(new RegExp(`/${IG_ID}/messages$`));
    expect(sent?.body).toEqual({ recipient: { comment_id: 'c5' }, message: { text: 'Hi!' } });
  });

  it('finds the account from the token’s granted targets when nothing is assigned', async () => {
    assignedEmpty = true;
    await call('PUT', '/api/instagram/settings', {
      loginUrl:
        'https://www.facebook.com/dialog/oauth?client_id=1076000000000001&config_id=2900000000000001',
      facebookAppSecret: FB_SECRET,
    });
    const start = new URL(String((await call('GET', '/api/instagram/connect')).headers.location));
    const back = await call(
      'GET',
      `/api/instagram/callback?code=abc&state=${encodeURIComponent(start.searchParams.get('state') ?? '')}`,
    );
    expect(String(back.headers.location)).toBe('/channels?connected=tgfromdebug');
    const debug = calls.find((c) => c.url.pathname.endsWith('/debug_token'));
    expect(debug?.url.searchParams.get('access_token')).toBe(`1076000000000001|${FB_SECRET}`);
  });

  it('asks for the account ID when Meta doesn’t say which account was shared', async () => {
    assignedEmpty = true;
    targetsEmpty = true;
    await call('PUT', '/api/instagram/settings', {
      loginUrl:
        'https://www.facebook.com/dialog/oauth?client_id=1076000000000001&config_id=2900000000000001',
      facebookAppSecret: FB_SECRET,
    });
    const start = new URL(String((await call('GET', '/api/instagram/connect')).headers.location));
    const back = await call(
      'GET',
      `/api/instagram/callback?code=abc&state=${encodeURIComponent(start.searchParams.get('state') ?? '')}`,
    );
    expect(String(back.headers.location)).toBe('/channels?account=needed');
    const settings = await call<{ accountIdNeeded: boolean }>('GET', '/api/instagram/settings');
    expect(settings.body.accountIdNeeded).toBe(true);

    // An ID the login didn't share fails at Meta.
    const wrong = await call('POST', '/api/instagram/accounts/by-id', {
      igUserId: '17841499999999999',
    });
    expect(wrong.body).toEqual({ error: 'not_shared' });

    const done = await call<{ accountIdNeeded: boolean; accounts: { username: string }[] }>(
      'POST',
      '/api/instagram/accounts/by-id',
      { igUserId: IG_ID },
    );
    expect(done.status).toBe(200);
    expect(done.body.accountIdNeeded).toBe(false);
    expect(done.body.accounts.map((a) => a.username)).toEqual(['tgfromdebug']);
    const [saved] = await db.select().from(instagramAccounts);
    expect(saved?.apiHost).toBe('facebook');
    expect(
      calls.some(
        (c) => c.method === 'POST' && c.url.pathname.endsWith(`/${IG_ID}/subscribed_apps`),
      ),
    ).toBe(true);
    // The kept token is used up.
    const again = await call('POST', '/api/instagram/accounts/by-id', { igUserId: IG_ID });
    expect(again.body).toEqual({ error: 'login_needed' });
  });

  it('says what to switch on when Instagram blocks messages from apps', async () => {
    await connect();
    const { body } = await call<{ flow: { id: string } }>('POST', '/api/flows', {
      name: 'Hello',
      starter: 'blank',
    });
    await call('PUT', `/api/flows/${body.flow.id}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'a', type: 'message', data: { parts: [{ type: 'text', text: 'Hi!' }] } },
        ],
        edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' }],
      },
    });
    await call('POST', `/api/flows/${body.flow.id}/publish`, {});
    await call('POST', '/api/triggers', { flowId: body.flow.id, config: { type: 'comment' } });
    const comment = (id: string, from: string) => ({
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          changes: [
            {
              field: 'comments',
              value: { id, text: 'hi', from: { id: from }, media: { id: 'm1' } },
            },
          ],
        },
      ],
    });
    type Status = { accounts: { statusDetail: string | null }[] };

    messagesOff = true;
    await webhook(comment('c7', 'fan-a'));
    await settled();
    const [failed] = await db.select().from(messages).where(eq(messages.status, 'failed'));
    expect(failed?.error).toContain('Allow access to messages');
    const flagged = await call<Status>('GET', '/api/instagram/settings');
    expect(flagged.body.accounts[0]?.statusDetail).toContain('Allow access to messages');

    // Switched on: the next reply goes through and the warning clears.
    messagesOff = false;
    await webhook(comment('c8', 'fan-b'));
    await settled();
    const cleared = await call<Status>('GET', '/api/instagram/settings');
    expect(cleared.body.accounts[0]?.statusDetail).toBeNull();
  });

  it('tells a real PDF link from a page that shows one', async () => {
    expect(await isPdfUrl('https://files.example.test/guide.pdf')).toBe(true);
    expect(await isPdfUrl('http://files.example.test/guide.pdf')).toBe(false);
    // What the builder shows under the file field.
    const page = await call('POST', '/api/instagram/check-file', {
      url: 'https://files.example.test/share/abc',
    });
    expect(page.body).toEqual({ pdf: false, reason: 'not_pdf', type: 'text/html' });
    // A PDF's own name is what Instagram shows on the document.
    const pdf = await call('POST', '/api/instagram/check-file', {
      url: 'https://files.example.test/Sling%20Inspection.pdf?sig=1',
    });
    expect(pdf.body).toEqual({ pdf: true, name: 'Sling Inspection.pdf' });
  });

  it('handles a DM once, even when another delivery starts a pass mid-way', async () => {
    await connect();
    const { body } = await call<{ flow: { id: string } }>('POST', '/api/flows', {
      name: 'Hello',
      starter: 'blank',
    });
    await call('PUT', `/api/flows/${body.flow.id}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'a', type: 'message', data: { parts: [{ type: 'text', text: 'Hi!' }] } },
        ],
        edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' }],
      },
    });
    await call('POST', `/api/flows/${body.flow.id}/publish`, {});
    await call('POST', '/api/triggers', {
      flowId: body.flow.id,
      config: { type: 'keyword', keywords: ['hello'], match: 'exact' },
    });
    const dm = (message: object, sender = 'fan-igsid') => ({
      object: 'instagram',
      entry: [
        { id: IG_ID, messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, message }] },
      ],
    });
    calls = [];
    let release = () => {};
    hold = new Promise((resolve) => {
      release = resolve;
    });

    await webhook(dm({ mid: 'in-1', text: 'hello' }));
    for (let i = 0; i < 100 && sends().length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    // While the reply is still going out, Instagram's echo of it arrives and starts another pass.
    await webhook(dm({ mid: 'out-1', text: 'Hi!', is_echo: true }, IG_ID));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await settled();

    expect(sends()).toHaveLength(1);
    const inbound = await db.select().from(messages).where(eq(messages.direction, 'in'));
    expect(inbound).toHaveLength(1);
  });

  it('fills in a contact from their Instagram profile once they message', async () => {
    await connect();
    const { body } = await call<{ flow: { id: string } }>('POST', '/api/flows', {
      name: 'Hello',
      starter: 'blank',
    });
    await call('PUT', `/api/flows/${body.flow.id}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'a',
            type: 'message',
            data: { parts: [{ type: 'text', text: 'Hi {{first_name | there}}!' }] },
          },
        ],
        edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' }],
      },
    });
    await call('POST', `/api/flows/${body.flow.id}/publish`, {});
    await call('POST', '/api/triggers', {
      flowId: body.flow.id,
      config: { type: 'keyword', keywords: ['hello'], match: 'exact' },
    });
    const dm = (mid: string, text: string) => ({
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          messaging: [
            { sender: { id: 'fan-igsid' }, recipient: { id: IG_ID }, message: { mid, text } },
          ],
        },
      ],
    });
    calls = [];
    await webhook(dm('in-1', 'hello'));
    await settled();

    // Fetched before the flow ran, so the very first reply knows their name.
    expect(sends()[0]?.body).toMatchObject({ message: { text: 'Hi Fan!' } });
    type Listed = { id: string; firstName: string; lastName: string; avatarVersion: number };
    const list = await call<{ contacts: Listed[] }>('GET', '/api/contacts');
    const fan = list.body.contacts[0];
    expect(fan).toMatchObject({ firstName: 'Fan', lastName: 'Person', username: 'fan_account' });
    expect(fan?.avatarVersion).toEqual(expect.any(Number));
    const detail = await call<{ identities: object[] }>('GET', `/api/contacts/${fan?.id}`);
    expect(detail.body.identities[0]).toMatchObject({
      displayName: 'Fan Person',
      followsUs: true,
      weFollow: false,
      followerCount: 12,
    });
    // The picture is kept here, since Instagram's link expires.
    const avatar = await app.inject({ url: `/api/contacts/${fan?.id}/avatar`, cookies });
    expect(avatar.headers['content-type']).toBe('image/jpeg');
    expect(avatar.body).toBe('fake-jpeg');

    // Within a week, another message doesn't ask Instagram again.
    calls = [];
    await webhook(dm('in-2', 'hello again'));
    await settled();
    expect(calls.some((c) => c.url.pathname.endsWith('/fan-igsid'))).toBe(false);
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
    expect(res.body).toMatchObject({ source: 'bundled' });
    expect(res.body.markdown).toMatch(/## step: webhooks \|/);
  });
});
