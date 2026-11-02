import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { contactIdentities } from './db/schema';
import { defaultChannels } from './runtime/channels';

// Web chat end to end: the team turns it on, a visitor on the website chats with a flow through
// the public routes (no sign-in), and a teammate replies from the Inbox.
const databaseUrl = process.env.TEST_DATABASE_URL;

type ChatMessage = {
  seq: number;
  from: 'visitor' | 'us';
  text?: string;
  parts?: { type: string; text?: string }[];
  buttons?: { id: string; kind: string; label: string; url?: string }[];
  quickReplies?: { id: string; label: string }[];
};

describe.skipIf(!databaseUrl)('web chat', () => {
  const config = { ...loadConfig({ NODE_ENV: 'test' }), databaseUrl: databaseUrl ?? '' };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;
  let cookies: Record<string, string> = {};

  /** As the signed-in owner. */
  const call = async <T = Record<string, unknown>>(
    method: InjectOptions['method'],
    url: string,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, payload, cookies });
    return { status: res.statusCode, body: res.json() as T };
  };
  /** As a visitor on someone's website: no cookies at all. */
  const visitor = async (url: string, payload?: object) => {
    const res = await app.inject({ method: payload ? 'POST' : 'GET', url, payload });
    return {
      status: res.statusCode,
      body: res.json() as { messages: ChatMessage[]; error?: string } & Record<string, unknown>,
      headers: res.headers,
    };
  };

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    app = await buildApp({ db, config, channels: defaultChannels() }, false);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate workspaces, users cascade`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        firstName: 'Brittany',
        email: 'owner@example.test',
        password: 'a long enough password',
        workspaceName: 'Studio',
      },
    });
    const session = res.cookies.find((c) => c.name === 'ss_session');
    cookies = session ? { ss_session: session.value } : {};
  });

  it('lets a visitor chat with the flows, and the team reply from the Inbox', async () => {
    expect(
      (await call<{ settings: { enabled: boolean } }>('GET', '/api/webchat/settings')).body.settings
        .enabled,
    ).toBe(false);
    const saved = await call<{ settings: { key: string } }>('PUT', '/api/webchat/settings', {
      enabled: true,
      title: 'Ask the studio',
      greeting: 'Hi! Ask us anything.',
      color: '#ff6600',
    });
    const key = saved.body.settings.key;
    expect(key).toMatch(/^wc_[\w-]{8,}$/);

    // The look is public (the site's page draws the button), so any site may read it.
    const look = await visitor(`/api/webchat/${key}`);
    expect(look.body).toEqual({
      title: 'Ask the studio',
      greeting: 'Hi! Ask us anything.',
      color: '#ff6600',
    });
    expect(look.headers['access-control-allow-origin']).toBe('*');

    const { body: made } = await call<{ flow: { id: string } }>('POST', '/api/flows', {
      name: 'Welcome',
      starter: 'welcome',
    });
    await call('POST', `/api/flows/${made.flow.id}/publish`);

    // A first message: the welcome flow answers, with its quick replies but none of its payloads.
    const token = 'visitor-token-0123456789abcdefghijklmn';
    let r = await visitor(`/api/webchat/${key}/send`, { token, text: 'hello' });
    expect(r.body.messages.map((m) => m.from)).toEqual(['visitor', 'us', 'us']);
    expect(r.body.messages[1]?.buttons?.[0]).toMatchObject({ label: 'Follow me' });
    const greet = r.body.messages[2] as ChatMessage;
    expect(greet.parts?.[0]?.text).toMatch(/How can I help/);
    expect(greet.quickReplies?.map((q) => q.label)).toEqual(['Pricing', 'Talk to a person']);
    expect(greet).not.toHaveProperty('payloads');

    // Tapping a quick reply goes by message and id; the label shows as what they said.
    r = await visitor(`/api/webchat/${key}/send`, {
      token,
      after: greet.seq,
      choice: { seq: greet.seq, id: 'qr_pricing' },
    });
    expect(r.body.messages.map((m) => [m.from, m.text ?? m.parts?.[0]?.text])).toEqual([
      ['visitor', 'Pricing'],
      ['us', 'Here’s everything on pricing 👇'],
    ]);
    expect(r.body.messages[1]?.buttons?.[0]).toMatchObject({ kind: 'url' });
    expect(
      (
        await visitor(`/api/webchat/${key}/send`, {
          token,
          choice: { seq: greet.seq, id: 'qr_nothing' },
        })
      ).status,
    ).toBe(409);

    // Another visitor sees nothing of this conversation.
    const stranger = await visitor(`/api/webchat/${key}/poll`, {
      token: 'someone-else-0123456789abcdefghijklmn',
    });
    expect(stranger.body.messages).toEqual([]);
    // Only a hash of the token is kept.
    const [identity] = await db
      .select({ externalId: contactIdentities.externalId, contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(eq(contactIdentities.channel, 'webchat'));
    expect(identity?.externalId).not.toBe(token);

    // The team sees it in the Inbox and can reply any time; the visitor's chat picks it up.
    const inbox = await call<{ conversations: { contactId: string; channel: string }[] }>(
      'GET',
      '/api/inbox',
    );
    expect(inbox.body.conversations[0]).toMatchObject({
      contactId: identity?.contactId,
      channel: 'webchat',
    });
    const detail = await call<{ alwaysOpen: boolean }>('GET', `/api/inbox/${identity?.contactId}`);
    expect(detail.body.alwaysOpen).toBe(true);
    const lastSeq = r.body.messages.at(-1)?.seq ?? 0;
    const sent = await call<{ message: { status: string } }>(
      'POST',
      `/api/inbox/${identity?.contactId}/reply`,
      { text: 'Hi, it’s Brittany. What are you making?' },
    );
    expect(sent.body.message.status).toBe('sent');
    const polled = await visitor(`/api/webchat/${key}/poll`, { token, after: lastSeq });
    expect(polled.body.messages.map((m) => m.parts?.[0]?.text)).toEqual([
      'Hi, it’s Brittany. What are you making?',
    ]);

    // Turned off: the chat disappears from the site.
    await call('PUT', '/api/webchat/settings', {
      enabled: false,
      title: 'Ask the studio',
      greeting: '',
      color: '#ff6600',
    });
    expect((await visitor(`/api/webchat/${key}`)).status).toBe(404);
    expect((await visitor(`/api/webchat/${key}/send`, { token, text: 'hi' })).status).toBe(404);
  });
});
