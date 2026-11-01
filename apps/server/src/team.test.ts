import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { notifier, setNotifyHttp } from './notify';
import { defaultChannels } from './runtime/channels';
import { receive } from './runtime/runtime';

// The team (invite links, roles, what agents may change) and push notifications through ntfy.

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('team and notifications', () => {
  const base = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'https://social.example.test' });
  const config = { ...base, databaseUrl: databaseUrl ?? '' };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;
  let owner: Record<string, string> = {};
  let setups = 0;
  let pushes: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    app = await buildApp({ db, config }, false);
    setNotifyHttp(async (input, init) => {
      pushes.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response('{}');
    });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    pushes = [];
    await db.execute(sql`truncate workspaces, users cascade`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: `10.0.1.${++setups}`,
      payload: {
        firstName: 'Todd',
        email: 'owner@example.test',
        password: 'a long enough password',
        workspaceName: 'Test',
      },
    });
    const session = res.cookies.find((c) => c.name === 'ss_session');
    owner = session ? { ss_session: session.value } : {};
  });

  const call = async <T = Record<string, unknown>>(
    cookies: Record<string, string>,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, payload, cookies });
    return { status: res.statusCode, body: res.json() as T, cookies: res.cookies };
  };

  it('invites a teammate who joins with the link, as an agent', async () => {
    const made = await call<{ link: string }>(owner, 'POST', '/api/team/invites', {
      email: 'Ann@Example.test',
      role: 'agent',
    });
    expect(made.body.link).toMatch(/^https:\/\/social\.example\.test\/invite\/[\w-]{20,}$/);
    const token = made.body.link.split('/invite/')[1] ?? '';

    const preview = await call({}, 'GET', `/api/invites/${token}`);
    expect(preview.body).toMatchObject({
      email: 'ann@example.test',
      role: 'agent',
      workspaceName: 'Test',
      accountExists: false,
    });
    const joined = await call({}, 'POST', `/api/invites/${token}/accept`, {
      firstName: 'Ann',
      password: 'another long password',
    });
    expect(joined.status).toBe(201);
    const session = joined.cookies.find((c) => c.name === 'ss_session');
    const agent: Record<string, string> = session ? { ss_session: session.value } : {};

    // Agents work the inbox; channel setup, notifications and the team are for owners and admins.
    const me = await call<{ workspaces: { role: string }[] }>(agent, 'GET', '/api/me');
    expect(me.body.workspaces[0]?.role).toBe('agent');
    expect((await call(agent, 'GET', '/api/inbox')).status).toBe(200);
    expect((await call(agent, 'PUT', '/api/instagram/settings', {})).status).toBe(403);
    expect((await call(agent, 'PUT', '/api/settings/notifications', { url: null })).status).toBe(
      403,
    );
    expect(
      (await call(agent, 'POST', '/api/team/invites', { email: 'x@example.test', role: 'agent' }))
        .status,
    ).toBe(403);

    // The link works once.
    expect((await call({}, 'GET', `/api/invites/${token}`)).status).toBe(404);
    const team = await call<{ members: { email: string; role: string }[] }>(
      owner,
      'GET',
      '/api/team',
    );
    expect(team.body.members.map((m) => [m.email, m.role])).toEqual([
      ['owner@example.test', 'owner'],
      ['ann@example.test', 'agent'],
    ]);
  });

  it('always keeps an owner', async () => {
    const team = await call<{ members: { userId: string }[] }>(owner, 'GET', '/api/team');
    const me = team.body.members[0]?.userId;
    expect((await call(owner, 'PATCH', `/api/team/members/${me}`, { role: 'admin' })).status).toBe(
      409,
    );
    expect((await call(owner, 'DELETE', `/api/team/members/${me}`)).status).toBe(409);
  });

  it('pushes through ntfy: a test, and a message nothing answered', async () => {
    const saved = await call(owner, 'PUT', '/api/settings/notifications', {
      url: 'https://ntfy.example.test/sb-topic',
      token: 'tk_secret',
    });
    expect(saved.body).toEqual({ url: 'https://ntfy.example.test/sb-topic', hasToken: true });
    expect((await call(owner, 'POST', '/api/settings/notifications/test')).status).toBe(200);
    expect(pushes[0]).toMatchObject({
      url: 'https://ntfy.example.test',
      headers: { authorization: 'Bearer tk_secret' },
      body: { topic: 'sb-topic', title: 'Social Switchboard' },
    });

    const r = await db.execute<{ id: string }>(sql`select id from workspaces limit 1`);
    const runtime = {
      db,
      channels: defaultChannels(),
      notify: notifier({ db, appSecret: config.appSecret, publicUrl: config.publicUrl }),
    };
    await receive(runtime, {
      workspaceId: r.rows[0]?.id ?? '',
      channel: 'instagram',
      externalId: 'ig-push-1',
      profile: { username: 'fan_account' },
      text: 'Do you ship to Canada?',
    });
    for (let i = 0; i < 50 && pushes.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pushes[1]?.body).toMatchObject({
      topic: 'sb-topic',
      title: '@fan_account sent a message',
      message: 'Do you ship to Canada?',
      click: expect.stringMatching(/^https:\/\/social\.example\.test\/inbox\/[\w-]+$/),
    });
  });
});
