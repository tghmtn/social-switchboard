import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';

// Runs against a real Postgres. Set TEST_DATABASE_URL (CI does; see README for local dev).
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('API', () => {
  const config = { ...loadConfig({ NODE_ENV: 'test' }), databaseUrl: databaseUrl ?? '' };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    app = await buildApp({ db, config }, false);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate users, workspaces, sessions, workspace_members cascade`);
  });

  const owner = {
    firstName: 'Owner',
    lastName: 'Person',
    email: 'Owner@Example.com',
    password: 'a long enough password',
    workspaceName: 'My Business',
  };
  const cookieFrom = (res: { cookies: { name: string; value: string }[] }) => {
    const cookies: Record<string, string> = {};
    const session = res.cookies.find((c) => c.name === 'ss_session');
    if (session) cookies.ss_session = session.value;
    return cookies;
  };

  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('runs first-time setup exactly once', async () => {
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needsSetup: true });

    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: owner });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({
      email: 'owner@example.com',
      firstName: 'Owner',
      lastName: 'Person',
      name: 'Owner Person',
    });

    const me = await app.inject({ url: '/api/me', cookies: cookieFrom(res) });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspaces).toEqual([
      expect.objectContaining({ name: 'My Business', role: 'owner' }),
    ]);

    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needsSetup: false });
    const again = await app.inject({ method: 'POST', url: '/api/setup', payload: owner });
    expect(again.statusCode).toBe(409);
  });

  it('rejects weak setup input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...owner, password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('logs in, and logout ends the session', async () => {
    await app.inject({ method: 'POST', url: '/api/setup', payload: owner });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: owner.email, password: 'wrong password' },
    });
    expect(bad.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: owner.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = cookieFrom(login);

    expect((await app.inject({ url: '/api/me', cookies })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
    expect((await app.inject({ url: '/api/me', cookies })).statusCode).toBe(401);
  });

  it('refuses non-JSON bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'email=a&password=b',
    });
    expect(res.statusCode).toBe(415);
  });
});
