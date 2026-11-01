import { createECDH } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { type Notice, notifier } from './notify';
import { defaultChannels } from './runtime/channels';
import { receive } from './runtime/runtime';
import { wakeSnoozed } from './runtime/snooze';
import { type PushTarget, setWebPushSender, vapidKeys } from './webpush';

// Inbox basics: saved replies, labels and channels as filters, snooze, and Switchboard's own
// notifications on a device (Web Push).

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('inbox basics', () => {
  const base = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'https://social.example.test' });
  const config = { ...base, databaseUrl: databaseUrl ?? '' };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;
  let owner: Record<string, string> = {};
  let ownerId = '';
  let workspaceId = '';
  let setups = 0;
  let sent: { target: PushTarget; payload: Record<string, unknown>; topic?: string }[] = [];
  /** Endpoints the fake push service says are gone. */
  let gone = new Set<string>();

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    app = await buildApp({ db, config }, false);
    setWebPushSender(async (target, payload, { topic }) => {
      if (gone.has(target.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      sent.push({ target, payload: JSON.parse(payload), topic });
    });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    sent = [];
    gone = new Set();
    await db.execute(sql`truncate workspaces, users cascade`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: `10.0.4.${++setups}`,
      payload: {
        firstName: 'Todd',
        email: 'owner@example.test',
        password: 'a long enough password',
        workspaceName: 'Test',
      },
    });
    const session = res.cookies.find((c) => c.name === 'ss_session');
    owner = session ? { ss_session: session.value } : {};
    const me = await call<{ user: { id: string }; workspaces: { id: string }[] }>(
      owner,
      'GET',
      '/api/me',
    );
    ownerId = me.body.user.id;
    workspaceId = me.body.workspaces[0]?.id ?? '';
  });

  const call = async <T = Record<string, unknown>>(
    cookies: Record<string, string>,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    headers?: Record<string, string>,
  ) => {
    const res = await app.inject({ method, url, payload, cookies, headers });
    return {
      status: res.statusCode,
      body: (res.body ? res.json() : undefined) as T,
    };
  };

  type Row = {
    contactId: string;
    tags: string[];
    snoozedUntil: string | null;
    backFromSnooze: boolean;
  };
  type List = { conversations: Row[]; counts: Record<string, number> };

  const dm = (externalId: string, text: string, channel = 'instagram', notify?: Notice[]) =>
    receive(
      {
        db,
        channels: defaultChannels(),
        notify: notify ? (n) => void notify.push(n) : undefined,
      },
      { workspaceId, channel, externalId, profile: { username: externalId }, text },
    );

  it('keeps saved replies for the team', async () => {
    const made = await call<{ reply: { id: string } }>(owner, 'POST', '/api/saved-replies', {
      title: 'Pricing',
      text: 'Hi {{first_name | there}}! Mugs are $28.',
    });
    expect(made.status).toBe(201);
    await call(owner, 'POST', '/api/saved-replies', { title: 'hours', text: 'Open 9 to 5.' });
    expect((await call(owner, 'POST', '/api/saved-replies', { title: '', text: 'x' })).status).toBe(
      400,
    );

    const list = await call<{ replies: { title: string }[] }>(owner, 'GET', '/api/saved-replies');
    expect(list.body.replies.map((r) => r.title)).toEqual(['hours', 'Pricing']);

    const id = made.body.reply.id;
    const changed = await call<{ reply: { text: string } }>(
      owner,
      'PUT',
      `/api/saved-replies/${id}`,
      { title: 'Pricing', text: 'Mugs are $30.' },
    );
    expect(changed.body.reply.text).toBe('Mugs are $30.');
    expect((await call(owner, 'DELETE', `/api/saved-replies/${id}`)).status).toBe(204);
    expect((await call(owner, 'DELETE', `/api/saved-replies/${id}`)).status).toBe(404);
  });

  it('filters by label and channel, with the counts to match', async () => {
    const { contactId: mugs } = await dm('mug_fan', 'Blue mug?');
    await dm('bowl_fan', 'Any bowls?');
    const { contactId: fb } = await dm('fb-123', 'Hello from Facebook', 'facebook');
    expect(
      (await call(owner, 'POST', `/api/contacts/${mugs}/tags`, { tag: 'Wholesale' })).status,
    ).toBe(200);
    await call(owner, 'POST', `/api/contacts/${fb}/tags`, { tag: 'Wholesale' });
    await call(owner, 'POST', `/api/contacts/${fb}/tags`, { tag: 'VIP' });
    const tags = await call<{ tags: { id: string; name: string }[] }>(owner, 'GET', '/api/tags');
    const wholesale = tags.body.tags.find((t) => t.name === 'Wholesale')?.id ?? '';

    const all = await call<List>(owner, 'GET', '/api/inbox');
    expect(all.body.counts.open).toBe(3);
    expect(all.body.conversations.find((c) => c.contactId === fb)?.tags).toEqual([
      'VIP',
      'Wholesale',
    ]);

    const labelled = await call<List>(owner, 'GET', `/api/inbox?tag=${wholesale}`);
    expect(labelled.body.conversations.map((c) => c.contactId).sort()).toEqual([mugs, fb].sort());
    expect(labelled.body.counts.open).toBe(2);

    const both = await call<List>(owner, 'GET', `/api/inbox?tag=${wholesale}&channel=facebook`);
    expect(both.body.conversations.map((c) => c.contactId)).toEqual([fb]);
    expect(both.body.counts.all).toBe(1);
    expect((await call(owner, 'GET', '/api/inbox?channel=tiktok')).status).toBe(400);
  });

  it('snoozes a conversation until a time, or until they write', async () => {
    const { contactId } = await dm('snoozer', 'Can I order next month?');
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      (
        await call(owner, 'POST', `/api/inbox/${contactId}/snooze`, {
          until: new Date(Date.now() - 60_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(owner, 'POST', `/api/inbox/${contactId}/snooze`, { until: inAnHour })).status,
    ).toBe(200);

    // Out of the open views (and the nav badge), in Snoozed.
    const open = await call<List>(owner, 'GET', '/api/inbox');
    expect(open.body.conversations).toHaveLength(0);
    expect(open.body.counts).toMatchObject({ open: 0, unread: 0, snoozed: 1 });
    expect((await call(owner, 'GET', '/api/inbox/summary')).body).toEqual({ unread: 0 });
    const snoozed = await call<List>(owner, 'GET', '/api/inbox?view=snoozed');
    expect(snoozed.body.conversations[0]?.snoozedUntil).toBe(inAnHour);
    const detail = await call<{ contact: { snoozedUntil: string } }>(
      owner,
      'GET',
      `/api/inbox/${contactId}`,
    );
    expect(detail.body.contact.snoozedUntil).toBe(inAnHour);

    // Not yet: nobody is told.
    const notices: Notice[] = [];
    expect(await wakeSnoozed(db, (n) => notices.push(n))).toBe(0);

    // Its time comes: it's back on top, and whoever snoozed it hears so, once.
    await db.execute(
      sql`update contacts set snoozed_until = now() - interval '1 minute' where id = ${contactId}`,
    );
    expect(await wakeSnoozed(db, (n) => notices.push(n))).toBe(1);
    expect(await wakeSnoozed(db, (n) => notices.push(n))).toBe(0);
    expect(notices).toEqual([
      expect.objectContaining({ contactId, kind: 'snooze', userId: ownerId }),
    ]);
    const back = await call<List>(owner, 'GET', '/api/inbox');
    expect(back.body.conversations[0]).toMatchObject({ contactId, backFromSnooze: true });
    // Once it's been looked at, it's an ordinary conversation again.
    await call(owner, 'POST', `/api/inbox/${contactId}/read`, {});
    expect((await call<List>(owner, 'GET', '/api/inbox')).body.conversations[0]).toMatchObject({
      backFromSnooze: false,
      snoozedUntil: null,
    });

    // Snoozed again, a new message from them brings it straight back (and no alert follows).
    await call(owner, 'POST', `/api/inbox/${contactId}/snooze`, { until: inAnHour });
    await dm('snoozer', 'Actually, can I order now?');
    expect((await call<List>(owner, 'GET', '/api/inbox')).body.conversations).toHaveLength(1);
    await db.execute(
      sql`update contacts set snoozed_until = now() - interval '1 minute' where id = ${contactId}`,
    );
    expect(await wakeSnoozed(db, (n) => notices.push(n))).toBe(0);

    // Unsnoozing by hand works too.
    await call(owner, 'POST', `/api/inbox/${contactId}/snooze`, { until: inAnHour });
    await call(owner, 'POST', `/api/inbox/${contactId}/snooze`, { until: null });
    expect((await call<List>(owner, 'GET', '/api/inbox')).body.counts.snoozed).toBe(0);
  });

  it('sends Switchboard’s own notifications to the devices people turn on', async () => {
    // Someone who had chosen their alerts before this existed gets notifications for those
    // alerts once they turn on their first device.
    await call(owner, 'PUT', '/api/settings/notifications/mine', {
      events: { handoff: ['email'], unanswered: [] },
    });
    expect(
      (await call(owner, 'POST', '/api/settings/notifications/test', { to: 'browser' })).status,
    ).toBe(409);
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
    const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
    const added = await call(
      owner,
      'POST',
      '/api/settings/notifications/devices',
      { endpoint: 'https://web.push.apple.com/device-one', keys },
      { 'user-agent': iphone },
    );
    expect(added.status).toBe(201);
    // The same device again just updates it.
    await call(
      owner,
      'POST',
      '/api/settings/notifications/devices',
      { endpoint: 'https://web.push.apple.com/device-one', keys },
      { 'user-agent': iphone },
    );
    await call(owner, 'POST', '/api/settings/notifications/devices', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-two',
      keys,
    });
    expect(
      (
        await call(owner, 'POST', '/api/settings/notifications/devices', {
          endpoint: 'http://insecure.example.test/x',
          keys,
        })
      ).status,
    ).toBe(400);

    const settings = await call<{
      vapidKey: string;
      mine: { events: Record<string, string[]>; devices: { id: string; label: string }[] };
    }>(owner, 'GET', '/api/settings/notifications');
    expect(settings.body.vapidKey).toBe(vapidKeys(config.appSecret).publicKey);
    expect(settings.body.mine.devices.map((d) => d.label).sort()).toEqual(['Browser', 'iPhone']);
    expect(settings.body.mine.events).toMatchObject({
      handoff: ['browser', 'email'],
      unanswered: [],
      snooze: ['browser', 'push'],
    });

    expect(
      (await call(owner, 'POST', '/api/settings/notifications/test', { to: 'browser' })).status,
    ).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.payload).toMatchObject({
      title: 'Social Switchboard',
      url: 'https://social.example.test/inbox',
    });

    // A hand-off reaches both devices; one of them has since gone, and is forgotten.
    sent = [];
    gone.add('https://fcm.googleapis.com/fcm/send/device-two');
    const notify = notifier({ db, appSecret: config.appSecret, publicUrl: config.publicUrl });
    const { contactId } = await dm('needs_help', 'I need a refund');
    notify({ workspaceId, contactId, channel: 'instagram', kind: 'handoff', text: 'Refund' });
    for (let i = 0; i < 100 && sent.length < 1; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: { endpoint: 'https://web.push.apple.com/device-one' },
      payload: {
        title: '@needs_help needs a person',
        body: 'Refund',
        url: `https://social.example.test/inbox/${contactId}`,
      },
      topic: contactId.replace(/-/g, ''),
    });
    const after = await call<{ mine: { devices: { id: string }[] } }>(
      owner,
      'GET',
      '/api/settings/notifications',
    );
    expect(after.body.mine.devices).toHaveLength(1);

    // Turning it off.
    const id = after.body.mine.devices[0]?.id;
    expect((await call(owner, 'DELETE', `/api/settings/notifications/devices/${id}`)).status).toBe(
      200,
    );
    expect((await call(owner, 'DELETE', `/api/settings/notifications/devices/${id}`)).status).toBe(
      404,
    );
  });

  it('derives the same push keys from the same secret', () => {
    const a = vapidKeys('secret-one-0123456789-0123456789');
    expect(vapidKeys('secret-one-0123456789-0123456789')).toEqual(a);
    expect(vapidKeys('secret-two-0123456789-0123456789').publicKey).not.toBe(a.publicKey);
    // A real P-256 key pair: the public key is the uncompressed point for the private one.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(a.privateKey, 'base64url'));
    expect(ecdh.getPublicKey().toString('base64url')).toBe(a.publicKey);
    expect(Buffer.from(a.publicKey, 'base64url')).toHaveLength(65);
  });
});
