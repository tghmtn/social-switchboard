import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { toMessengerMessages } from './facebook/channel';
import { setHttp } from './instagram/graph';
import { setEchoGraceMs } from './instagram/takeover';

// Facebook Pages: Messenger message shapes, connecting Pages through Facebook Login, and a comment
// that turns into a private reply and continues in Messenger, against a fake Graph API.

describe('toMessengerMessages', () => {
  const msg = {
    parts: [
      { type: 'text' as const, text: 'Here you go' },
      { type: 'file' as const, url: 'https://files.example.test/guide.pdf', name: 'Guide.pdf' },
      { type: 'file' as const, url: 'https://files.example.test/page', name: 'Menu' },
    ],
    buttons: [{ id: 'b1', kind: 'url' as const, label: 'Shop', url: 'https://shop.example.test' }],
    quickReplies: [{ id: 'q1', label: 'More' }],
  };

  it('sends a PDF as a file and other links as tappable text, buttons and quick replies last', () => {
    const out = toMessengerMessages(
      msg,
      { q1: 'p-q1' },
      false,
      new Set(['https://files.example.test/guide.pdf']),
    );
    expect(out).toEqual([
      { text: 'Here you go' },
      {
        attachment: {
          type: 'file',
          payload: { url: 'https://files.example.test/guide.pdf', is_reusable: true },
        },
      },
      {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: '📄 Menu: https://files.example.test/page',
            buttons: [{ type: 'web_url', url: 'https://shop.example.test', title: 'Shop' }],
          },
        },
        quick_replies: [{ content_type: 'text', title: 'More', payload: 'p-q1' }],
      },
    ]);
  });

  it('collapses to one message for a private reply, files as buttons', () => {
    const out = toMessengerMessages(msg, {}, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      attachment: {
        payload: {
          text: 'Here you go',
          buttons: [
            { title: 'Shop' },
            { url: 'https://files.example.test/guide.pdf', title: '📄 Guide.pdf' },
            { url: 'https://files.example.test/page', title: '📄 Menu' },
          ],
        },
      },
    });
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const APP_ID = '1234567890123456';
const FB_SECRET = 'b'.repeat(32);
const PAGE = '102030405060';
const OTHER_PAGE = '102030405061';

type Call = { method: string; url: URL; body: unknown };

describe.skipIf(!databaseUrl)('Facebook Pages end to end (fake Meta)', () => {
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
  let setups = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fakeMeta: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    if (path === '/oauth/access_token')
      return json({
        access_token: url.searchParams.get('grant_type') ? 'long-user-token' : 'short-user-token',
      });
    if (path === '/me/accounts')
      return json({
        data: [
          {
            id: PAGE,
            name: 'Pottery Studio',
            access_token: 'page-token',
            picture: { data: { url: 'https://cdn.example.test/p.jpg' } },
          },
        ],
      });
    // A second Page that only a Business portfolio owns.
    if (path === '/me/businesses') return json({ data: [{ id: 'biz1' }] });
    if (path === '/biz1/owned_pages')
      return json({ data: [{ id: OTHER_PAGE, name: 'Studio Two', access_token: 'page-token-2' }] });
    if (path === '/biz1/client_pages') return json({ data: [] });
    if (path.endsWith('/subscribed_apps')) return json({ success: true });
    if (path === `/${PAGE}/messages`)
      return json({ recipient_id: 'psid-ann', message_id: `m_${calls.length}` });
    if (path.endsWith('/comments')) return json({ id: 'public-reply-1' });
    if (path === '/psid-ann')
      return json({ first_name: 'Ann', last_name: 'Lee', profile_pic: 'x' });
    if (path === `/${PAGE}/posts`)
      return json({
        data: [{ id: `${PAGE}_9`, message: 'Spring classes!', created_time: '2026-10-30' }],
      });
    return json({ error: { message: `unexpected ${path}`, code: 100 } }, 400);
  };

  const call = async <T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  const webhook = (payload: object) => {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/api/instagram/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', FB_SECRET).update(raw).digest('hex')}`,
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
      if (i % 10 === 9) await webhook({ object: 'page', entry: [] });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('webhook events never finished processing');
  };
  const sends = () =>
    calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith(`/${PAGE}/messages`));

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
    setEchoGraceMs(30_000);
    await db.execute(sql`truncate workspaces, users, webhook_events cascade`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: `10.0.3.${++setups}`,
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

  /** Facebook Login through to the Page picker, then connects `pick`. */
  async function connect(pick = [PAGE]) {
    await call('PUT', '/api/facebook/settings', { appId: APP_ID, appSecret: FB_SECRET });
    const start = await call('GET', '/api/facebook/connect');
    const location = new URL(String(start.headers.location));
    const back = await call(
      'GET',
      `/api/facebook/callback?code=abc&state=${encodeURIComponent(location.searchParams.get('state') ?? '')}`,
    );
    const picked = await call<{ pages: { pageId: string }[]; failed: string[] }>(
      'POST',
      '/api/facebook/pages',
      { pageIds: pick },
    );
    return { start: location, back: String(back.headers.location), picked: picked.body };
  }

  it('connects the Pages picked after Facebook Login, Business-owned ones included', async () => {
    const { start, back, picked } = await connect([PAGE, OTHER_PAGE]);
    expect(start.origin + start.pathname).toMatch(
      /^https:\/\/www\.facebook\.com\/v[\d.]+\/dialog\/oauth$/,
    );
    expect(start.searchParams.get('client_id')).toBe(APP_ID);
    expect(start.searchParams.get('redirect_uri')).toBe(
      'https://switchboard.example.test/api/facebook/callback',
    );
    expect(start.searchParams.get('scope')).toContain('pages_messaging');
    expect(back).toBe('/channels/facebook?choose=2');
    expect(picked.failed).toEqual([]);
    expect(picked.pages.map((p) => p.pageId).sort()).toEqual([PAGE, OTHER_PAGE]);
    // Each Page's webhooks are switched on, comments ("feed") included.
    const subscribed = calls.filter((c) => c.url.pathname.endsWith('/subscribed_apps'));
    expect(subscribed).toHaveLength(2);
    expect(subscribed[0]?.url.searchParams.get('subscribed_fields')).toContain('feed');

    // The picker list is used up; a configuration ID switches login to Login for Business.
    const s = await call<{ pending: unknown[] }>('GET', '/api/facebook/settings');
    expect(s.body.pending).toEqual([]);
    await call('PUT', '/api/facebook/settings', { configId: '998877665544' });
    const again = new URL(String((await call('GET', '/api/facebook/connect')).headers.location));
    expect(again.searchParams.get('config_id')).toBe('998877665544');
    expect(again.searchParams.has('scope')).toBe(false);
  });

  it('turns a Page comment into a private reply, and the Messenger reply continues it', async () => {
    await connect();
    const flowId = (await call<{ flow: { id: string } }>('POST', '/api/flows', { name: 'Classes' }))
      .body.flow.id;
    await call('PUT', `/api/flows/${flowId}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'hi',
            type: 'message',
            data: {
              parts: [{ type: 'text', text: 'Hi {{first_name | there}}! Classes are $40.' }],
              quickReplies: [{ id: 'book', label: 'Book one' }],
            },
          },
          {
            id: 'booked',
            type: 'message',
            data: { parts: [{ type: 'text', text: 'Great, {{first_name}}! See you Saturday.' }] },
          },
        ],
        edges: [
          { id: 'e1', source: 'start', sourceHandle: 'next', target: 'hi' },
          { id: 'e2', source: 'hi', sourceHandle: 'book', target: 'booked' },
        ],
      },
    });
    await call('POST', `/api/flows/${flowId}/publish`, {});
    await call('POST', '/api/triggers', {
      flowId,
      config: { type: 'comment', keywords: ['CLASS'], publicReplies: ['Sent you a message!'] },
    });

    await webhook({
      object: 'page',
      entry: [
        {
          id: PAGE,
          time: 1,
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: `${PAGE}_9_77`,
                post_id: `${PAGE}_9`,
                message: 'CLASS please',
                from: { id: 'asid-ann', name: 'Ann Lee' },
              },
            },
            // The Page's own comment never triggers anything.
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: `${PAGE}_9_78`,
                post_id: `${PAGE}_9`,
                message: 'CLASS',
                from: { id: PAGE, name: 'Pottery Studio' },
              },
            },
          ],
        },
      ],
    });
    await settled();
    const first = sends();
    expect(first).toHaveLength(1);
    expect(first[0]?.body).toMatchObject({
      recipient: { comment_id: `${PAGE}_9_77` },
      messaging_type: 'RESPONSE',
      message: {
        text: 'Hi Ann! Classes are $40.',
        quick_replies: [{ title: 'Book one' }],
      },
    });
    const publicReply = calls.find((c) => c.url.pathname.endsWith(`/${PAGE}_9_77/comments`));
    expect(publicReply?.body).toEqual({ message: 'Sent you a message!' });

    // They tap the quick reply in Messenger, as their Messenger self (a different id).
    const sent = first[0]?.body as
      | { message: { quick_replies: { payload: string }[] } }
      | undefined;
    const payload = sent?.message.quick_replies[0]?.payload;
    await webhook({
      object: 'page',
      entry: [
        {
          id: PAGE,
          messaging: [
            {
              sender: { id: 'psid-ann' },
              recipient: { id: PAGE },
              message: { mid: 'in-1', text: 'Book one', quick_reply: { payload } },
            },
          ],
        },
      ],
    });
    await settled();
    expect(sends().at(-1)?.body).toMatchObject({
      recipient: { id: 'psid-ann' },
      message: { text: 'Great, Ann! See you Saturday.' },
    });
    // One person, both ids.
    const people = await db.execute<{ n: number }>(sql`select count(*)::int as n from contacts`);
    expect(people.rows[0]?.n).toBe(1);
    const ids = await db.execute<{ external_id: string }>(
      sql`select external_id from contact_identities where channel = 'facebook' order by external_id`,
    );
    expect(ids.rows.map((r) => r.external_id)).toEqual(['asid-ann', 'psid-ann']);

    // Their posts are there to pick for a trigger.
    const posts = await call<{ posts: { id: string; pageName: string }[] }>(
      'GET',
      '/api/facebook/posts',
    );
    expect(posts.body.posts).toEqual([
      expect.objectContaining({ id: `${PAGE}_9`, pageName: 'Pottery Studio' }),
    ]);
  });

  it('pauses the bot when someone replies from the Page, and disconnects cleanly', async () => {
    await connect();
    setEchoGraceMs(0);
    await webhook({
      object: 'page',
      entry: [
        {
          id: PAGE,
          messaging: [
            {
              sender: { id: 'psid-ann' },
              recipient: { id: PAGE },
              message: { mid: 'in-1', text: 'hello?' },
            },
          ],
        },
      ],
    });
    await settled();
    await webhook({
      object: 'page',
      entry: [
        {
          id: PAGE,
          messaging: [
            {
              sender: { id: PAGE },
              recipient: { id: 'psid-ann' },
              message: { mid: 'echo-1', text: 'Hi Ann, Todd here', is_echo: true },
            },
          ],
        },
      ],
    });
    await settled();
    const paused = await db.execute<{ first_name: string; paused: boolean }>(
      sql`select first_name, automation_resume_at is not null as paused from contacts`,
    );
    expect(paused.rows).toEqual([{ first_name: 'Ann', paused: true }]);

    const s = await call<{ pages: { id: string }[] }>('GET', '/api/facebook/settings');
    const removed = await call<{ pages: unknown[] }>(
      'DELETE',
      `/api/facebook/pages/${s.body.pages[0]?.id}`,
    );
    expect(removed.body.pages).toEqual([]);
    expect(
      calls.some((c) => c.method === 'DELETE' && c.url.pathname.endsWith('/subscribed_apps')),
    ).toBe(true);
  });
});
