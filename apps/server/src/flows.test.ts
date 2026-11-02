import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { csvCell } from './csv';
import { createDb, runMigrations } from './db/client';
import type { OutboundContent } from './db/schema';
import { defaultChannels } from './runtime/channels';
import { wakeDue } from './runtime/runtime';

// End-to-end: real Postgres, real runtime, driven through the HTTP API and the simulator channel.
const databaseUrl = process.env.TEST_DATABASE_URL;

type FlowDetail = {
  flow: { draft: unknown; publishedVersionId: string | null };
  triggers: { config: unknown; position: number }[];
};
type SimState = {
  contact: {
    id: string;
    followsUs: boolean;
    tags: string[];
    fields: Record<string, unknown>;
    automationPausedAt: string | null;
  } | null;
  messages: {
    direction: 'in' | 'out';
    status: string;
    content: OutboundContent | { kind: 'in'; text?: string };
  }[];
  runs: { status: string; waitKind: string | null; flowName: string }[];
};

describe.skipIf(!databaseUrl)('flows, contacts and the simulator', () => {
  const config = {
    ...loadConfig({ NODE_ENV: 'test', TZ: 'America/Denver' }),
    databaseUrl: databaseUrl ?? '',
  };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;
  let cookies: Record<string, string> = {};
  let setups = 0;

  const call = async <T = unknown>(
    method: InjectOptions['method'],
    url: string,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, payload, cookies });
    const json = String(res.headers['content-type'] ?? '').includes('json');
    return { status: res.statusCode, body: (json ? res.json() : undefined) as T, raw: res.body };
  };
  const outText = (s: SimState) =>
    s.messages.flatMap((m) =>
      m.content.kind === 'out'
        ? m.content.message.parts.map((p) => (p.type === 'text' ? p.text : p.url))
        : [],
    );
  const lastOut = (s: SimState) => {
    const m = s.messages.filter((x) => x.content.kind === 'out').at(-1);
    return m?.content as OutboundContent;
  };

  async function createFlow(name: string, starter: string) {
    const { body } = await call<{ flow: { id: string } }>('POST', '/api/flows', { name, starter });
    return body.flow.id;
  }

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
      remoteAddress: `10.0.5.${++setups}`,
      payload: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
        password: 'a long enough password',
        workspaceName: 'Test',
      },
    });
    const session = res.cookies.find((c) => c.name === 'ss_session');
    cookies = session ? { ss_session: session.value } : {};
  });

  it('requires sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/flows' });
    expect(res.statusCode).toBe(401);
  });

  it('runs the WORKSHOP lead magnet from keyword to CSV export', async () => {
    const flowId = await createFlow('Workshop', 'lead_magnet');
    const detail = await call<{
      issues: unknown[];
      triggers: { config: { keywords: string[] } }[];
    }>('GET', `/api/flows/${flowId}`);
    expect(detail.body.issues).toEqual([]);
    expect(detail.body.triggers[0]?.config.keywords).toEqual(['WORKSHOP']);

    // Not published yet, so the keyword does nothing.
    let s = (await call<SimState>('POST', '/api/simulator/send', { text: 'workshop' })).body;
    expect(outText(s)).toEqual([]);

    expect((await call('POST', `/api/flows/${flowId}/publish`)).status).toBe(200);
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'Workshop!' })).body;
    // The worksheet comes straight away, with a tap for more instead of a question first.
    const sent = lastOut(s);
    expect(sent.message.parts[0]).toMatchObject({ text: expect.stringContaining('worksheet') });
    expect(sent.message.buttons.map((b) => b.label)).toEqual(['Get the worksheet', 'Send me more']);
    expect(s.runs[0]?.status).toBe('completed');

    // Tap "Send me more" the way Instagram reports a button: its label plus our payload.
    s = (
      await call<SimState>('POST', '/api/simulator/tap', {
        payload: sent.payloads.btn_more,
        label: 'Send me more',
      })
    ).body;
    expect(outText(s).at(-1)).toMatch(/Love it, Ada! What’s your email\?/);

    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'not an email' })).body;
    expect(outText(s).at(-1)).toMatch(/doesn’t look like an email/);
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'Ada@Example.test' })).body;

    const delivered = lastOut(s);
    expect(delivered.message.buttons.map((b) => (b.kind === 'url' ? b.url : ''))).toEqual([
      'https://example.com/register?email=ada%40example.test',
    ]);
    expect(s.messages.every((m) => m.status === 'sent' || m.direction === 'in')).toBe(true);
    expect(s.runs[0]?.status).toBe('completed');
    expect(s.contact?.tags).toEqual(['workshop-interest', 'lead']);
    expect(s.contact?.fields).toMatchObject({ email: 'ada@example.test', first_name: 'Ada' });

    // The lead shows up in Contacts, with a timeline and consent.
    const list = await call<{
      contacts: { id: string; tags: string[]; email: string }[];
      total: number;
    }>('GET', '/api/contacts?tag=lead');
    expect(list.body.total).toBe(1);
    const contactId = list.body.contacts[0]?.id;
    const one = await call<{
      consents: { channel: string; granted: boolean }[];
      events: { type: string }[];
    }>('GET', `/api/contacts/${contactId}`);
    expect(one.body.consents).toEqual([
      expect.objectContaining({ channel: 'email', granted: true }),
    ]);
    expect(one.body.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'flow_started',
        'tag_added',
        'field_set',
        'consent_changed',
        'flow_completed',
      ]),
    );

    const csv = await call('GET', '/api/contacts/export.csv');
    const [header, row] = csv.raw.trim().split('\r\n');
    expect(header).toBe(
      'id,first_name,last_name,email,phone,username,tags,channels,email_consent,sms_consent,created_at,last_seen_at',
    );
    expect(row).toContain(
      ',Ada,Lovelace,ada@example.test,,,lead; workshop-interest,simulator,true,,',
    );
  });

  it('checks “follows you” against the test contact’s switch', async () => {
    const flowId = await createFlow('Follow first', 'follow_first');
    expect((await call('POST', `/api/flows/${flowId}/publish`)).status).toBe(200);

    // A comment: nobody has said they follow, so the private reply asks them to.
    let s = (await call<SimState>('POST', '/api/simulator/comment', { text: 'guide please' })).body;
    // (The public "Sent you a DM" under the comment comes after it.)
    const ask = s.messages
      .map((m) => m.content)
      .find((c): c is OutboundContent => c.kind === 'out' && Boolean(c.privateReplyTo));
    if (!ask) throw new Error('no private reply');
    expect(ask.message.parts[0]).toMatchObject({ text: expect.stringMatching(/following me/) });
    // No Instagram account connected, so the profile link keeps its placeholder to edit.
    expect(ask.message.buttons[0]).toMatchObject({ url: 'https://www.instagram.com/your_handle' });
    expect(s.contact?.followsUs).toBe(false);

    s = (await call<SimState>('POST', '/api/simulator/follows', { follows: true })).body;
    expect(s.contact?.followsUs).toBe(true);
    s = (
      await call<SimState>('POST', '/api/simulator/tap', {
        payload: ask.payloads.btn_following,
        label: 'I’m following',
      })
    ).body;
    expect(outText(s).at(-1)).toMatch(/Thanks for following/);
    expect(s.contact?.tags).toEqual(['guide-sent']);
  });

  it('tests a draft with a delay, then fast-forwards it', async () => {
    const flowId = await createFlow('Follow-up', 'blank');
    const graph = {
      nodes: [
        { id: 'start', type: 'start' },
        {
          id: 'hi',
          type: 'message',
          data: { parts: [{ type: 'text', text: 'Hi {{first_name}}' }] },
        },
        { id: 'wait', type: 'delay', data: { mode: 'duration', amount: 2, unit: 'days' } },
        {
          id: 'later',
          type: 'message',
          data: { parts: [{ type: 'text', text: 'Two days later' }] },
        },
      ],
      edges: [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'hi' },
        { id: 'e2', source: 'hi', sourceHandle: 'next', target: 'wait' },
        { id: 'e3', source: 'wait', sourceHandle: 'next', target: 'later' },
      ],
    };
    expect(
      (await call<{ issues: unknown[] }>('PUT', `/api/flows/${flowId}/draft`, { graph })).body
        .issues,
    ).toEqual([]);

    let s = (await call<SimState>('POST', '/api/simulator/start', { flowId, version: 'draft' }))
      .body;
    expect(outText(s)).toEqual(['Hi Ada']);
    expect(s.runs[0]).toMatchObject({ status: 'waiting', waitKind: 'delay' });

    // A message during the delay doesn't disturb it.
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'hello?' })).body;
    expect(s.runs[0]).toMatchObject({ status: 'waiting', waitKind: 'delay' });

    s = (await call<SimState>('POST', '/api/simulator/fast-forward')).body;
    expect(outText(s)).toEqual(['Hi Ada', 'Two days later']);
    expect(s.runs[0]?.status).toBe('completed');
  });

  it('wakes due runs from the worker loop', async () => {
    const flowId = await createFlow('Timer', 'blank');
    await call('PUT', `/api/flows/${flowId}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'wait', type: 'delay', data: { mode: 'duration', amount: 5, unit: 'minutes' } },
          { id: 'done', type: 'message', data: { parts: [{ type: 'text', text: 'Time’s up' }] } },
        ],
        edges: [
          { id: 'e1', source: 'start', sourceHandle: 'next', target: 'wait' },
          { id: 'e2', source: 'wait', sourceHandle: 'next', target: 'done' },
        ],
      },
    });
    await call('POST', '/api/simulator/start', { flowId, version: 'draft' });
    const runtime = { db, channels: defaultChannels() };

    expect(await wakeDue({ ...runtime, now: () => new Date(Date.now() + 60_000) })).toBe(0);
    expect(await wakeDue({ ...runtime, now: () => new Date(Date.now() + 6 * 60_000) })).toBe(1);
    const s = (await call<SimState>('GET', '/api/simulator')).body;
    expect(outText(s)).toEqual(['Time’s up']);
  });

  it('greets a first message, inviting someone who doesn’t follow yet to follow', async () => {
    const flowId = await createFlow('New follower greeting', 'welcome');
    await call('POST', `/api/flows/${flowId}/publish`);

    let s = (await call<SimState>('POST', '/api/simulator/send', { text: 'hi!' })).body;
    expect(outText(s)).toEqual([
      'Hi Ada, thanks for reaching out! 💛 Follow me so you never miss a post.',
      'How can I help?',
    ]);

    // A follower gets thanked instead, even with the switch flipped before their first message.
    await call('POST', '/api/simulator/reset');
    await call('POST', '/api/simulator/follows', { follows: true });
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'hi!' })).body;
    expect(outText(s)).toEqual(['Hi Ada, thanks for following! 💛', 'How can I help?']);
    // Not new once they've written: the next message doesn't greet them again.
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'hello?' })).body;
    expect(outText(s)).toHaveLength(2);
  });

  it('hands off to a person and stays quiet until resumed', async () => {
    const flowId = await createFlow('Welcome', 'welcome');
    await call('POST', `/api/flows/${flowId}/publish`);

    let s = (await call<SimState>('POST', '/api/simulator/send', { text: 'hello there' })).body;
    expect(outText(s).at(-1)).toMatch(/How can I help/);
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'talk to a person' })).body;
    expect(outText(s).at(-1)).toMatch(/I’ll reply right here/);
    expect(s.contact?.automationPausedAt).not.toBeNull();

    const before = outText(s).length;
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'hello?' })).body;
    expect(outText(s)).toHaveLength(before);
    expect(s.messages.at(-1)).toMatchObject({ direction: 'in' });

    await call('POST', `/api/contacts/${s.contact?.id}/resume-automation`);
    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'pricing' })).body;
    // Not a new contact any more and "pricing" isn't a keyword: nothing fires, and that's right.
    expect(outText(s)).toHaveLength(before);
  });

  it('duplicates an automation as an unpublished copy with its triggers', async () => {
    const id = await createFlow('Follow first', 'follow_first');
    await call('POST', `/api/flows/${id}/publish`);
    const original = (await call<FlowDetail>('GET', `/api/flows/${id}`)).body;

    const made = await call<{ flow: { id: string; name: string } }>(
      'POST',
      `/api/flows/${id}/duplicate`,
      {},
    );
    expect(made.status).toBe(201);
    expect(made.body.flow.name).toBe('Follow first (copy)');
    const copy = (await call<FlowDetail>('GET', `/api/flows/${made.body.flow.id}`)).body;
    expect(copy.flow.draft).toEqual(original.flow.draft);
    expect(copy.flow.publishedVersionId).toBeNull();
    expect(copy.triggers.map((t) => t.config)).toEqual(original.triggers.map((t) => t.config));
    // The copies go last, so the original keeps answering its keyword.
    expect(copy.triggers[0]?.position).toBeGreaterThan(original.triggers[0]?.position ?? 0);

    expect((await call('POST', `/api/flows/${randomUUID()}/duplicate`, {})).status).toBe(404);
  });

  it('chains into another flow and picks keyword over default reply', async () => {
    const second = await createFlow('Second', 'blank');
    await call('PUT', `/api/flows/${second}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'm',
            type: 'message',
            data: { parts: [{ type: 'text', text: 'From the second flow' }] },
          },
        ],
        edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'm' }],
      },
    });
    const first = await createFlow('First', 'blank');
    const graph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'go', type: 'goto_flow', data: { flowId: second } },
      ],
      edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'go' }],
    };
    await call('PUT', `/api/flows/${first}/draft`, { graph });

    // Publishing "first" fails until "second" exists; it exists, so both publish.
    expect((await call('POST', `/api/flows/${first}/publish`)).status).toBe(200);
    expect((await call('POST', `/api/flows/${second}/publish`)).status).toBe(200);
    await call('POST', '/api/triggers', {
      flowId: first,
      config: { type: 'keyword', keywords: ['chain'], match: 'contains' },
    });
    await call('POST', '/api/triggers', { flowId: second, config: { type: 'default_reply' } });

    let s = (
      await call<SimState>('POST', '/api/simulator/send', { text: 'start the chain please' })
    ).body;
    expect(outText(s)).toEqual(['From the second flow']);
    expect(s.runs.map((r) => r.flowName)).toEqual(['Second', 'First']);

    s = (await call<SimState>('POST', '/api/simulator/send', { text: 'anything else' })).body;
    expect(outText(s)).toEqual(['From the second flow', 'From the second flow']);
  });

  it('rejects broken graphs and refuses to publish wiring errors', async () => {
    const flowId = await createFlow('Broken', 'blank');
    const bad = await call('PUT', `/api/flows/${flowId}/draft`, {
      graph: { nodes: [{ id: 'x', type: 'nope' }], edges: [] },
    });
    expect(bad.status).toBe(400);

    const wiring = await call<{ issues: { code: string }[] }>('PUT', `/api/flows/${flowId}/draft`, {
      graph: {
        nodes: [{ id: 'start', type: 'start' }],
        edges: [{ id: 'e', source: 'start', sourceHandle: 'next', target: 'ghost' }],
      },
    });
    expect(wiring.body.issues.map((i) => i.code)).toContain('edge_unknown_node');
    expect((await call('POST', `/api/flows/${flowId}/publish`)).status).toBe(422);
  });

  it('manages fields and tags, and deletes contacts completely', async () => {
    expect((await call('POST', '/api/fields', { key: 'email', label: 'Email' })).status).toBe(400);
    expect(
      (await call('POST', '/api/fields', { key: 'budget', label: 'Budget', type: 'number' }))
        .status,
    ).toBe(201);
    expect((await call('POST', '/api/fields', { key: 'budget', label: 'Again' })).status).toBe(409);

    const s = (await call<SimState>('POST', '/api/simulator/send', { text: 'hi' })).body;
    const id = s.contact?.id;
    await call('PATCH', `/api/contacts/${id}`, { email: 'X@Y.test', fields: { budget: 5000 } });
    await call('POST', `/api/contacts/${id}/tags`, { tag: 'VIP' });
    const tags = await call<{ tags: { name: string; contacts: number }[] }>('GET', '/api/tags');
    expect(tags.body.tags).toEqual([expect.objectContaining({ name: 'VIP', contacts: 1 })]);

    const detail = await call<{
      contact: { email: string; fields: { key: string; value: unknown }[] };
    }>('GET', `/api/contacts/${id}`);
    expect(detail.body.contact.email).toBe('x@y.test');
    expect(detail.body.contact.fields).toEqual([
      expect.objectContaining({ key: 'budget', value: 5000 }),
    ]);

    expect((await call('DELETE', `/api/contacts/${id}`)).status).toBe(204);
    expect((await call('GET', `/api/contacts/${id}`)).status).toBe(404);
    expect((await call<SimState>('GET', '/api/simulator')).body.contact).toBeNull();
  });
});

describe('csvCell', () => {
  it('quotes and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell(null)).toBe('');
  });
});
