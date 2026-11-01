import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { layOut, setAssistantClient } from './ai/assistant';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { aiActions, aiUsage, flows } from './db/schema';

// The in-app assistant against a scripted Claude: reading runs on its own, changes wait for a yes,
// and the conversation goes back to the API exactly as it came out.

const databaseUrl = process.env.TEST_DATABASE_URL;

describe('layOut', () => {
  it('places new steps by distance from the start and keeps existing positions', () => {
    const out = layOut({
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'a', type: 'message', data: {} },
        { id: 'b', type: 'message', data: {}, position: { x: 999, y: 5 } },
        { id: 'c', type: 'message', data: {} },
      ],
      edges: [
        { source: 'start', sourceHandle: 'next', target: 'a' },
        { source: 'a', sourceHandle: 'q1', target: 'b' },
        { source: 'a', sourceHandle: 'q2', target: 'c' },
      ],
    });
    expect(out.nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 320, y: 0 },
      { x: 999, y: 5 },
      { x: 640, y: 0 },
    ]);
    expect(out.edges.every((e) => typeof e.id === 'string')).toBe(true);
  });
});

describe.skipIf(!databaseUrl)('assistant', () => {
  const base = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'https://social.example.test' });
  const config = { ...base, databaseUrl: databaseUrl ?? '' };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;
  let cookies: Record<string, string> = {};
  let setups = 0;
  let requests: Record<string, unknown>[] = [];
  let script: Record<string, unknown>[] = [];
  let keys: string[] = [];

  const reply = (content: object[], stop_reason = 'end_turn') => ({
    id: `msg_${script.length}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
  });

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    app = await buildApp({ db, config }, false);
    setAssistantClient((apiKey) => {
      keys.push(apiKey);
      return {
        beta: {
          messages: {
            create: async (params: Record<string, unknown>) => {
              // A copy: the loop keeps appending to the same array afterwards.
              requests.push(structuredClone(params));
              const next = script.shift();
              if (!next) throw new Error('the script ran out');
              return next;
            },
          },
        },
      } as never;
    });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    requests = [];
    script = [];
    keys = [];
    await db.execute(sql`truncate workspaces, users cascade`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: `10.0.2.${++setups}`,
      payload: {
        firstName: 'Todd',
        email: 'owner@example.test',
        password: 'a long enough password',
        workspaceName: 'Test',
      },
    });
    const session = res.cookies.find((c) => c.name === 'ss_session');
    cookies = session ? { ss_session: session.value } : {};
  });

  const call = async <T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, payload, cookies });
    return { status: res.statusCode, body: res.json() as T };
  };
  type View = {
    id: string;
    status: string;
    error: string | null;
    items: {
      type: string;
      text?: string;
      label?: string;
      state?: string;
      detail?: string[];
      id?: string;
    }[];
  };
  /** Waits for the background turn to finish. */
  const settled = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const v = await call<View>('GET', `/api/assistant/threads/${id}`);
      if (v.body.status !== 'working') return v.body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the assistant never finished');
  };

  const graph = {
    nodes: [
      { id: 'start', type: 'start', data: {} },
      {
        id: 'hello',
        type: 'message',
        data: {
          parts: [{ type: 'text', text: 'Here’s the guide 👇' }],
          quickReplies: [{ id: 'more', label: 'More' }],
        },
      },
    ],
    edges: [{ source: 'start', sourceHandle: 'next', target: 'hello' }],
  };

  it('reads on its own, waits for a yes before building, and keeps the conversation intact', async () => {
    expect(
      (await call('PUT', '/api/settings/ai', { apiKey: 'sk-ant-test-0123456789abcdefghij' })).body,
    ).toMatchObject({
      hasKey: true,
      model: 'claude-opus-5-5',
      effort: 'medium',
    });
    const thread = (await call<View>('POST', '/api/assistant/threads')).body;

    script = [
      reply(
        [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          { type: 'tool_use', id: 'tu_1', name: 'list_flows', input: {} },
        ],
        'tool_use',
      ),
      reply(
        [
          { type: 'text', text: 'I’ll make a GUIDE flow.' },
          { type: 'tool_use', id: 'tu_2', name: 'create_flow', input: { name: 'Guide', graph } },
        ],
        'tool_use',
      ),
      reply([{ type: 'text', text: 'Done: the flow is saved as a draft.' }]),
    ];
    const sent = await call<View>('POST', `/api/assistant/threads/${thread.id}/messages`, {
      text: 'Make a flow that sends my guide',
      page: '/flows',
    });
    expect(sent.status).toBe(202);
    const waiting = await settled(thread.id);
    expect(waiting.status).toBe('waiting');
    expect(keys).toEqual(['sk-ant-test-0123456789abcdefghij']);
    const proposal = waiting.items.find((i) => i.label === 'Create the flow “Guide”');
    expect(proposal).toMatchObject({
      state: 'waiting',
      detail: ['Start', 'Message: Here’s the guide 👇 (More)'],
    });
    expect(waiting.items.find((i) => i.label === 'Looked at your flows')?.state).toBe('done');
    expect(await db.select().from(flows)).toHaveLength(0); // nothing built before the yes

    await call('POST', `/api/assistant/threads/${thread.id}/decide`, { approve: ['tu_2'] });
    const done = await settled(thread.id);
    expect(done.status).toBe('idle');
    expect(done.items.at(-1)).toEqual({
      type: 'assistant',
      text: 'Done: the flow is saved as a draft.',
    });
    const [made] = await db.select().from(flows);
    expect(made?.name).toBe('Guide');
    expect(
      (made?.draft as { nodes: { position: unknown }[] } | undefined)?.nodes[1]?.position,
    ).toEqual({
      x: 320,
      y: 0,
    });
    expect(made?.publishedVersionId).toBeNull();

    // What went to Claude: the defaults, a cacheable system prompt, and earlier turns unchanged.
    const first = requests[0] as Record<string, unknown>;
    expect(first).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
    });
    const second = requests[1] as { messages: { role: string; content: unknown }[] };
    expect(second.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'tu_1', name: 'list_flows', input: {} },
      ],
    });
    const third = requests[2] as {
      messages: { role: string; content: { tool_use_id?: string; is_error?: boolean }[] }[];
    };
    expect(third.messages.at(-1)?.content).toMatchObject([
      { tool_use_id: 'tu_2', is_error: false },
    ]);

    expect(await db.select().from(aiUsage)).toHaveLength(3);
    const actions = await db.select().from(aiActions);
    expect(actions.map((a) => [a.tool, a.decision, a.ok])).toEqual([
      ['list_flows', 'auto', true],
      ['create_flow', 'approved', true],
    ]);
    const usage = await call<{ models: { requests: number; estimatedCost: number }[] }>(
      'GET',
      '/api/settings/ai/usage',
    );
    expect(usage.body.models[0]?.requests).toBe(3);
    expect(usage.body.models[0]?.estimatedCost).toBeGreaterThan(0);
  });

  it('tells Claude when a change is declined, and saves nothing', async () => {
    await call('PUT', '/api/settings/ai', {
      apiKey: 'sk-ant-test-0123456789abcdefghij',
      model: 'claude-haiku-5-5',
    });
    const flow = (await call<{ flow: { id: string } }>('POST', '/api/flows', { name: 'Existing' }))
      .body.flow;
    const thread = (await call<View>('POST', '/api/assistant/threads')).body;
    script = [
      reply(
        [{ type: 'tool_use', id: 'tu_p', name: 'publish_flow', input: { flowId: flow.id } }],
        'tool_use',
      ),
      reply([{ type: 'text', text: 'Okay, I’ll leave it unpublished.' }]),
    ];
    await call('POST', `/api/assistant/threads/${thread.id}/messages`, { text: 'Publish it' });
    const waiting = await settled(thread.id);
    expect(waiting.items.find((i) => i.id === 'tu_p')?.label).toBe('Publish “Existing”');
    await call('POST', `/api/assistant/threads/${thread.id}/decide`, { approve: [] });
    const done = await settled(thread.id);
    expect(done.items.find((i) => i.id === 'tu_p')?.state).toBe('declined');
    const [unchanged] = await db.select().from(flows).where(eq(flows.id, flow.id));
    expect(unchanged?.publishedVersionId).toBeNull();
    // Haiku gets no server-side fallback.
    expect(requests[0]).not.toHaveProperty('fallbacks');
    expect(requests[0]).toMatchObject({ model: 'claude-haiku-5-5' });
  });

  it('needs a key before it can start', async () => {
    const thread = (await call<View>('POST', '/api/assistant/threads')).body;
    const res = await call('POST', `/api/assistant/threads/${thread.id}/messages`, { text: 'Hi' });
    expect(res.status).toBe(409);
  });
});
