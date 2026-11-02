import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { layOut } from './ai/assistant';
import { setAiClient } from './ai/client';
import { setOpenAiFetch } from './ai/openai';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { aiActions, aiUsage, flows } from './db/schema';
import { defaultChannels } from './runtime/channels';
import { receive } from './runtime/runtime';

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
    setAiClient((apiKey) => {
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
      (
        await call('PUT', '/api/settings/ai', {
          anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
        })
      ).body,
    ).toMatchObject({
      provider: 'anthropic',
      ready: true,
      anthropic: { hasKey: true, keyHint: '…ghij', model: 'claude-opus-5-5' },
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
      page: '/automations',
    });
    expect(sent.status).toBe(202);
    const waiting = await settled(thread.id);
    expect(waiting.status).toBe('waiting');
    expect(new Set(keys)).toEqual(new Set(['sk-ant-test-0123456789abcdefghij']));
    const proposal = waiting.items.find((i) => i.label === 'Create the automation “Guide”');
    expect(proposal).toMatchObject({
      state: 'waiting',
      detail: ['Start', 'Message: Here’s the guide 👇 (More)'],
    });
    expect(waiting.items.find((i) => i.label === 'Looked at your automations')?.state).toBe('done');
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
      anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij', model: 'claude-haiku-5-5' },
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

  it('drafts an inbox reply from the conversation', async () => {
    await call('PUT', '/api/settings/ai', {
      anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
    });
    const [ws] = (await db.execute<{ id: string }>(sql`select id from workspaces limit 1`)).rows;
    const { contactId } = await receive(
      { db, channels: defaultChannels() },
      {
        workspaceId: ws?.id ?? '',
        channel: 'instagram',
        externalId: 'ig-fan',
        profile: { username: 'fan', firstName: 'Fan' },
        text: 'How much is the workshop?',
      },
    );
    script = [reply([{ type: 'text', text: 'It’s [price] and includes the worksheet!' }])];
    const res = await call<{ text: string }>('POST', `/api/inbox/${contactId}/suggest`);
    expect(res.body).toEqual({ text: 'It’s [price] and includes the worksheet!' });
    expect(requests[0]).toMatchObject({ output_config: { effort: 'low' } });
    const prompt = JSON.stringify((requests[0] as { messages: unknown }).messages);
    expect(prompt).toContain('Fan: How much is the workshop?');
  });

  it('runs an AI step in a flow: replies, collects a field, and leaves through "done"', async () => {
    await call('PUT', '/api/settings/ai', {
      anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
    });
    const flowId = (await call<{ flow: { id: string } }>('POST', '/api/flows', { name: 'Booking' }))
      .body.flow.id;
    const saved = await call<{ issues: unknown[] }>('PUT', `/api/flows/${flowId}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start', position: { x: 0, y: 0 } },
          {
            id: 'chat',
            type: 'ai',
            position: { x: 300, y: 0 },
            data: {
              goal: 'Find out which class they want and get their email',
              instructions: 'Classes: Pottery (Saturdays), Painting (Sundays).',
              collect: [{ key: 'email', description: 'their email address' }],
            },
          },
          {
            id: 'thanks',
            type: 'message',
            position: { x: 600, y: 0 },
            data: { parts: [{ type: 'text', text: 'Thanks!' }] },
          },
        ],
        edges: [
          { id: 'e1', source: 'start', sourceHandle: 'next', target: 'chat' },
          { id: 'e2', source: 'chat', sourceHandle: 'done', target: 'thanks' },
        ],
      },
    });
    expect(saved.body.issues).toEqual([]);
    const json = (o: object) => reply([{ type: 'text', text: JSON.stringify(o) }]);
    type Sim = {
      contact: { fields: Record<string, unknown> } | null;
      messages: { content: { kind: string; message?: { parts: { text?: string }[] } } }[];
      runs: { status: string }[];
    };
    const said = (s: Sim) =>
      s.messages.flatMap((m) =>
        m.content.kind === 'out' ? (m.content.message?.parts ?? []).map((p) => p.text) : [],
      );

    script = [json({ reply: 'Which class would you like?', fields: [], outcome: 'continue' })];
    let sim = (await call<Sim>('POST', '/api/simulator/start', { flowId, version: 'draft' })).body;
    expect(said(sim)).toEqual(['Which class would you like?']);
    expect(requests[0]).toMatchObject({
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(JSON.stringify(requests[0])).toContain('Classes: Pottery (Saturdays)');

    script = [
      json({
        reply: 'Pottery it is, see you Saturday!',
        fields: [{ key: 'email', value: 'ada@example.com' }],
        outcome: 'done',
      }),
    ];
    sim = (
      await call<Sim>('POST', '/api/simulator/send', { text: 'Pottery please, ada@example.com' })
    ).body;
    expect(said(sim)).toEqual([
      'Which class would you like?',
      'Pottery it is, see you Saturday!',
      'Thanks!',
    ]);
    expect(sim.contact?.fields.email).toBe('ada@example.com');
    expect(sim.runs[0]?.status).toBe('completed');
    expect(JSON.stringify(requests[1])).toContain('Them: Pottery please, ada@example.com');
  });

  it('sends an AI step’s first reply as the private reply when a comment started the flow', async () => {
    await call('PUT', '/api/settings/ai', {
      anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
    });
    const flowId = (await call<{ flow: { id: string } }>('POST', '/api/flows', { name: 'Ask' }))
      .body.flow.id;
    await call('PUT', `/api/flows/${flowId}/draft`, {
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'chat', type: 'ai', data: { goal: 'Answer their question about the workshop' } },
        ],
        edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'chat' }],
      },
    });
    await call('POST', `/api/flows/${flowId}/publish`, {});
    await call('POST', '/api/triggers', { flowId, config: { type: 'comment' } });
    script = [
      reply([
        {
          type: 'text',
          text: JSON.stringify({ reply: 'It’s on Saturday!', fields: [], outcome: 'continue' }),
        },
      ]),
    ];
    const sim = (
      await call<{
        messages: { direction: string; content: { privateReplyTo?: string; message?: unknown } }[];
      }>('POST', '/api/simulator/comment', { text: 'when is it?' })
    ).body;
    const out = sim.messages.filter((m) => m.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]?.content.privateReplyTo).toEqual(expect.any(String));
  });

  describe('AI sort steps', () => {
    const sortFlow = async () => {
      const flowId = (await call<{ flow: { id: string } }>('POST', '/api/flows', { name: 'Sort' }))
        .body.flow.id;
      const text = (t: string) => ({ parts: [{ type: 'text', text: t }] });
      const saved = await call<{ issues: unknown[] }>('PUT', `/api/flows/${flowId}/draft`, {
        graph: {
          nodes: [
            { id: 'start', type: 'start' },
            {
              id: 'sort',
              type: 'ai_route',
              data: {
                intents: [
                  { id: 'pricing', label: 'Pricing', description: 'asks what it costs' },
                  { id: 'booking', label: 'Booking' },
                ],
                saveTo: 'topic',
              },
            },
            { id: 'prices', type: 'message', data: text('Classes are $40.') },
            { id: 'other', type: 'message', data: text('Tell me more?') },
          ],
          edges: [
            { id: 'e1', source: 'start', sourceHandle: 'next', target: 'sort' },
            { id: 'e2', source: 'sort', sourceHandle: 'pricing', target: 'prices' },
            { id: 'e3', source: 'sort', sourceHandle: 'else', target: 'other' },
          ],
        },
      });
      expect(saved.body.issues).toEqual([]);
      return flowId;
    };
    type Sim = {
      contact: { fields: Record<string, unknown> } | null;
      messages: {
        direction: string;
        content: { privateReplyTo?: string; message?: { parts: { text?: string }[] } };
      }[];
    };
    const said = (s: Sim) =>
      s.messages.flatMap((m) =>
        m.direction === 'out' ? (m.content.message?.parts ?? []).map((p) => p.text) : [],
      );

    it('sorts the comment that started a flow, answers in the private reply, and saves the pick', async () => {
      await call('PUT', '/api/settings/ai', {
        anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
      });
      const flowId = await sortFlow();
      await call('POST', `/api/flows/${flowId}/publish`, {});
      await call('POST', '/api/triggers', { flowId, config: { type: 'comment' } });
      script = [reply([{ type: 'text', text: JSON.stringify({ intent: 'pricing' }) }])];
      const sim = (await call<Sim>('POST', '/api/simulator/comment', { text: 'how much is it?' }))
        .body;
      expect(said(sim)).toEqual(['Classes are $40.']);
      expect(sim.messages.find((m) => m.direction === 'out')?.content.privateReplyTo).toEqual(
        expect.any(String),
      );
      expect(sim.contact?.fields.topic).toBe('Pricing');
      expect(requests[0]).toMatchObject({
        output_config: {
          effort: 'low',
          format: {
            schema: { properties: { intent: { enum: ['pricing', 'booking', 'none'] } } },
          },
        },
      });
      expect(JSON.stringify(requests[0])).toContain('Their latest message: how much is it?');
    });

    it('goes through "else" for "none", and without a key never calls the AI', async () => {
      const flowId = await sortFlow();
      let sim = (await call<Sim>('POST', '/api/simulator/start', { flowId, version: 'draft' }))
        .body;
      expect(said(sim)).toEqual(['Tell me more?']);
      expect(requests).toEqual([]);

      await call('PUT', '/api/settings/ai', {
        anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
      });
      await call('POST', `/api/flows/${flowId}/publish`, {});
      await call('POST', '/api/triggers', { flowId, config: { type: 'default_reply' } });
      script = [reply([{ type: 'text', text: JSON.stringify({ intent: 'none' }) }])];
      sim = (await call<Sim>('POST', '/api/simulator/send', { text: 'love your work!' })).body;
      expect(said(sim).at(-1)).toBe('Tell me more?');
      expect(sim.contact?.fields).not.toHaveProperty('topic');
    });
  });

  it('needs a key before it can start', async () => {
    const thread = (await call<View>('POST', '/api/assistant/threads')).body;
    const res = await call('POST', `/api/assistant/threads/${thread.id}/messages`, { text: 'Hi' });
    expect(res.status).toBe(409);
  });

  it('asks one question at a time, takes a typed answer, and opens pages', async () => {
    await call('PUT', '/api/settings/ai', {
      anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
    });
    const thread = (await call<View>('POST', '/api/assistant/threads')).body;
    script = [
      reply(
        [
          { type: 'text', text: 'Here’s the plan: 1. the guide link, 2. the keyword, 3. done.' },
          {
            type: 'tool_use',
            id: 'tu_q',
            name: 'ask_user',
            input: {
              question: 'What’s the link to your guide?',
              help: 'A direct PDF arrives as a document.',
              kind: 'url',
              step: 1,
              steps: 3,
            },
          },
        ],
        'tool_use',
      ),
      reply(
        [
          { type: 'tool_use', id: 'tu_p', name: 'open_page', input: { path: '/automations' } },
          { type: 'tool_use', id: 'tu_x', name: 'open_page', input: { path: '/admin/secret' } },
        ],
        'tool_use',
      ),
      reply([{ type: 'text', text: 'That’s a PDF, so it arrives as a document.' }]),
    ];
    await call('POST', `/api/assistant/threads/${thread.id}/messages`, { text: 'Build a flow' });
    const asking = await settled(thread.id);
    expect(asking.status).toBe('waiting');
    expect(asking.items.find((i) => i.type === 'ask')).toMatchObject({
      question: 'What’s the link to your guide?',
      kind: 'url',
      step: 1,
      steps: 3,
      state: 'waiting',
    });

    // Typing in the box answers the question.
    const answered = await call('POST', `/api/assistant/threads/${thread.id}/messages`, {
      text: 'https://example.com/guide.pdf',
    });
    expect(answered.status).toBe(202);
    const done = await settled(thread.id);
    expect(done.status).toBe('idle');
    expect(done.items.find((i) => i.type === 'ask')).toMatchObject({
      state: 'answered',
      answer: 'https://example.com/guide.pdf',
    });
    expect(done.items.find((i) => i.id === 'tu_p')).toMatchObject({
      label: 'Opened Automations',
      navigate: '/automations',
      state: 'done',
    });
    // Only the app's own pages.
    expect(done.items.find((i) => i.id === 'tu_x')).toMatchObject({ state: 'failed' });
    expect(done.items.find((i) => i.id === 'tu_x')).not.toHaveProperty('navigate');
    expect(JSON.stringify(requests[1])).toContain('They answered: https://example.com/guide.pdf');
  });

  describe('on OpenAI', () => {
    let openaiCalls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    let openaiScript: { status?: number; body: unknown }[] = [];
    const MODELS = [
      { id: 'gpt-6-astra', created: 1_790_000_000 },
      { id: 'gpt-5.6-luna', created: 1_795_000_000 },
      { id: 'gpt-6-astra-2026-09-01', created: 1_795_000_000 },
      { id: 'text-embedding-3-large', created: 1_795_000_000 },
      { id: 'gpt-realtime', created: 1_795_000_000 },
      { id: 'gpt-4-turbo', created: 1_700_000_000 },
    ];
    const usage = {
      input_tokens: 1000,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 800 },
    };
    const said = (text: string) => ({
      model: 'gpt-6-astra',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      ],
      usage,
    });

    beforeAll(() => {
      setOpenAiFetch((async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace('https://api.openai.com/v1', '');
        openaiCalls.push({
          method: init?.method ?? 'GET',
          path,
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        if (path === '/models')
          return new Response(JSON.stringify({ object: 'list', data: MODELS }), { status: 200 });
        const next = openaiScript.shift();
        if (!next) throw new Error('the OpenAI script ran out');
        return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
      }) as typeof fetch);
    });
    beforeEach(() => {
      openaiCalls = [];
      openaiScript = [];
    });

    it('picks a model from the live list, and keeps both keys', async () => {
      await call('PUT', '/api/settings/ai', {
        anthropic: { apiKey: 'sk-ant-test-0123456789abcdefghij' },
      });
      const saved = await call('PUT', '/api/settings/ai', {
        provider: 'openai',
        openai: { apiKey: 'sk-proj-test-0123456789abcdefghij' },
      });
      expect(saved.body).toMatchObject({
        provider: 'openai',
        ready: true,
        anthropic: { hasKey: true },
        openai: { hasKey: true, keyHint: '…ghij', model: 'gpt-6-astra' },
      });
      const listed = await call<{ models: { id: string }[]; suggested: string }>(
        'GET',
        '/api/settings/ai/models?provider=openai',
      );
      expect(listed.body.models.map((m) => m.id)).toEqual(['gpt-5.6-luna', 'gpt-6-astra']);
      expect(listed.body.suggested).toBe('gpt-6-astra');
      const shown = await call('POST', '/api/settings/ai/reveal', { provider: 'openai' });
      expect(shown.body).toEqual({ value: 'sk-proj-test-0123456789abcdefghij' });
    });

    it('runs the assistant, carrying its reasoning back, and the AI steps', async () => {
      await call('PUT', '/api/settings/ai', {
        provider: 'openai',
        openai: { apiKey: 'sk-proj-test-0123456789abcdefghij', model: 'gpt-6-astra' },
      });
      const thread = (await call<View>('POST', '/api/assistant/threads')).body;
      openaiScript = [
        {
          body: {
            model: 'gpt-6-astra',
            status: 'completed',
            output: [
              { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] },
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'list_flows',
                arguments: '{}',
              },
            ],
            usage,
          },
        },
        { body: said('You have no flows yet.') },
      ];
      await call('POST', `/api/assistant/threads/${thread.id}/messages`, { text: 'Any flows?' });
      const v = await settled(thread.id);
      expect(v.status).toBe('idle');
      expect(v.items.map((i) => i.text ?? i.label)).toEqual([
        'Any flows?',
        'Looked at your automations',
        'You have no flows yet.',
      ]);
      const second = openaiCalls.filter((c) => c.path === '/responses')[1]?.body ?? {};
      expect(second).toMatchObject({
        model: 'gpt-6-astra',
        store: false,
        reasoning: { effort: 'medium' },
      });
      const input = second.input as { type?: string; role?: string; call_id?: string }[];
      expect(input.map((i) => i.type ?? i.role)).toEqual([
        'user',
        'reasoning',
        'function_call',
        'function_call_output',
      ]);
      expect((second.tools as { type: string }[]).every((t) => t.type === 'function')).toBe(true);
      const [used] = await db.select().from(aiUsage).limit(1);
      expect(used).toMatchObject({ model: 'gpt-6-astra', inputTokens: 200, cacheReadTokens: 800 });

      // An AI sort step, on a model that turns out not to take reasoning settings.
      const flowId = (await call<{ flow: { id: string } }>('POST', '/api/flows', { name: 'Sort' }))
        .body.flow.id;
      await call('PUT', `/api/flows/${flowId}/draft`, {
        graph: {
          nodes: [
            { id: 'start', type: 'start' },
            {
              id: 'sort',
              type: 'ai_route',
              data: { intents: [{ id: 'pricing', label: 'Pricing' }] },
            },
            {
              id: 'prices',
              type: 'message',
              data: { parts: [{ type: 'text', text: 'Classes are $40.' }] },
            },
          ],
          edges: [
            { id: 'e1', source: 'start', sourceHandle: 'next', target: 'sort' },
            { id: 'e2', source: 'sort', sourceHandle: 'pricing', target: 'prices' },
          ],
        },
      });
      await call('POST', `/api/flows/${flowId}/publish`, {});
      await call('POST', '/api/triggers', { flowId, config: { type: 'default_reply' } });
      openaiCalls = [];
      openaiScript = [
        {
          status: 400,
          body: { error: { message: "Unsupported parameter: 'reasoning.effort'." } },
        },
        { body: said('{"intent":"pricing"}') },
      ];
      const sim = (
        await call<{ messages: { direction: string; content: { message?: unknown } }[] }>(
          'POST',
          '/api/simulator/send',
          { text: 'how much?' },
        )
      ).body;
      expect(JSON.stringify(sim.messages.at(-1)?.content)).toContain('Classes are $40.');
      const [refused, retried] = openaiCalls.map((c) => c.body);
      expect(refused).toMatchObject({
        reasoning: { effort: 'low' },
        text: { format: { type: 'json_schema', strict: true } },
      });
      expect(retried).not.toHaveProperty('reasoning');
    });
  });
});
