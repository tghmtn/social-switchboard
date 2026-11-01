import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { type Mail, notifier, setMailer, setNotifyHttp } from './notify';
import { defaultChannels } from './runtime/channels';
import { receive } from './runtime/runtime';

// The team (invite links, roles, what agents may change) and notifications: ntfy push, email over
// SMTP and Twilio texts, routed by each teammate's choices.

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
  let mails: Mail[] = [];

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    app = await buildApp({ db, config }, false);
    setNotifyHttp(async (input, init) => {
      const raw = String(init?.body);
      pushes.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        // ntfy takes JSON; Twilio takes a form.
        body: raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)),
      });
      return new Response('{}');
    });
    setMailer(async (_smtp, mail) => {
      mails.push(mail);
    });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    pushes = [];
    mails = [];
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
      (
        await call(agent, 'PUT', '/api/settings/notifications/email', {
          host: 'smtp.example.test',
          port: 587,
          security: 'starttls',
          from: 'a@example.test',
        })
      ).status,
    ).toBe(403);
    // But everyone chooses their own alerts.
    expect(
      (await call(agent, 'PUT', '/api/settings/notifications/mine', { events: { team: [] } }))
        .status,
    ).toBe(200);
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

  it('routes alerts by each teammate’s choices: their push topic, email over SMTP, texts', async () => {
    expect(
      (
        await call(owner, 'PUT', '/api/settings/notifications/email', {
          host: 'smtp.example.test',
          port: 587,
          security: 'starttls',
          user: 'bot',
          password: 'smtp-password',
          from: 'alerts@example.test',
          fromName: 'Pottery Studio',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(owner, 'PUT', '/api/settings/notifications/sms', {
          accountSid: `AC${'0'.repeat(32)}`,
          token: 'twilio-auth-token-0123456789',
          from: '+18015550000',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(owner, 'PUT', '/api/settings/notifications/mine', {
          pushUrl: 'https://ntfy.example.test/todd-phone',
          phone: '+18015551234',
          events: { handoff: ['push', 'email', 'sms'], unanswered: [] },
        })
      ).status,
    ).toBe(200);
    const settings = await call<{
      email: { host: string; hasPassword: boolean };
      sms: { hasToken: boolean };
      mine: { events: Record<string, string[]>; accountEmail: string };
    }>(owner, 'GET', '/api/settings/notifications');
    expect(settings.body).toMatchObject({
      email: { host: 'smtp.example.test', hasPassword: true },
      sms: { hasToken: true },
      mine: {
        accountEmail: 'owner@example.test',
        events: {
          handoff: ['push', 'email', 'sms'],
          unanswered: [],
          assigned: ['browser', 'push', 'email'],
        },
      },
    });
    expect(
      (await call(owner, 'POST', '/api/settings/notifications/reveal', { which: 'email' })).body,
    ).toEqual({ value: 'smtp-password' });

    // Tests go to your own addresses.
    expect(
      (await call(owner, 'POST', '/api/settings/notifications/test', { to: 'email' })).status,
    ).toBe(200);
    expect(mails[0]).toMatchObject({ to: 'owner@example.test', subject: 'Social Switchboard' });
    expect(
      (await call(owner, 'POST', '/api/settings/notifications/test', { to: 'sms' })).status,
    ).toBe(200);
    expect(pushes.at(-1)).toMatchObject({
      url: `https://api.twilio.com/2010-04-01/Accounts/AC${'0'.repeat(32)}/Messages.json`,
      body: { To: '+18015551234', From: '+18015550000' },
    });
    pushes = [];
    mails = [];

    const r = await db.execute<{ id: string }>(sql`select id from workspaces limit 1`);
    const workspaceId = r.rows[0]?.id ?? '';
    const notify = notifier({ db, appSecret: config.appSecret, publicUrl: config.publicUrl });
    const runtime = { db, channels: defaultChannels(), notify };
    // Nothing answered this DM, and they turned those alerts off.
    const { contactId } = await receive(runtime, {
      workspaceId,
      channel: 'instagram',
      externalId: 'ig-route-1',
      profile: { username: 'mug_buyer' },
      text: 'Is the blue mug still available?',
    });
    // A hand-off goes every way they chose.
    notify({
      workspaceId,
      contactId,
      channel: 'instagram',
      kind: 'handoff',
      text: 'Wants a refund',
    });
    // Someone else's assignment reaches nobody here.
    notify({ workspaceId, contactId, channel: 'inbox', kind: 'assigned', userId: workspaceId });
    for (let i = 0; i < 100 && (pushes.length < 2 || mails.length < 1); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to: 'owner@example.test',
      subject: '@mug_buyer needs a person',
      text: expect.stringContaining('Wants a refund'),
    });
    expect(mails[0]?.html).toContain(`https://social.example.test/inbox/${contactId}`);
    expect(pushes.map((p) => p.url).sort()).toEqual([
      `https://api.twilio.com/2010-04-01/Accounts/AC${'0'.repeat(32)}/Messages.json`,
      'https://ntfy.example.test',
    ]);
    expect(pushes.find((p) => p.url === 'https://ntfy.example.test')?.body).toMatchObject({
      topic: 'todd-phone',
      title: '@mug_buyer needs a person',
    });
  });
});
