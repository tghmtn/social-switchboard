import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { parseSignedRequest, signRequest } from './meta';
import { defaultChannels } from './runtime/channels';
import { receive } from './runtime/runtime';

const SECRET = 'test-meta-app-secret';

describe('parseSignedRequest', () => {
  it('accepts Meta-signed payloads and rejects tampering', () => {
    const signed = signRequest({ algorithm: 'HMAC-SHA256', user_id: '123' }, SECRET);
    expect(parseSignedRequest(signed, SECRET)?.user_id).toBe('123');
    expect(parseSignedRequest(signed, 'wrong-secret')).toBeNull();
    const [sig, payload] = signed.split('.');
    const forged = Buffer.from(
      JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '999' }),
    ).toString('base64url');
    expect(parseSignedRequest(`${sig}.${forged}`, SECRET)).toBeNull();
    expect(parseSignedRequest(`${sig}.${payload}extra`, SECRET)).toBeNull();
    expect(parseSignedRequest('garbage', SECRET)).toBeNull();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('privacy page and data deletion', () => {
  const base = loadConfig({
    NODE_ENV: 'test',
    META_APP_SECRET: SECRET,
    PUBLIC_URL: 'https://social.example.test',
  });
  const config = { ...base, databaseUrl: databaseUrl ?? '' };
  const { db, pool } = createDb(config.databaseUrl);
  let app: FastifyInstance;
  let workspaceId = '';

  beforeAll(async () => {
    await runMigrations(db, config.migrationsDir);
    app = await buildApp({ db, config }, false);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate workspaces, users, deletion_requests cascade`);
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        firstName: 'Owner',
        email: 'o@example.test',
        password: 'a long enough password',
        workspaceName: 'Most <Likely> Late',
      },
    });
    const r = await db.execute<{ id: string }>(sql`select id from workspaces limit 1`);
    workspaceId = r.rows[0]?.id ?? '';
  });

  const deletion = (signed: string) =>
    app.inject({
      method: 'POST',
      url: '/api/meta/data-deletion',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(signed)}`,
    });

  it('serves a privacy policy naming the workspace, escaped', async () => {
    const res = await app.inject({ url: '/privacy' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Most &#60;Likely&#62; Late');
    expect(res.body).not.toContain('<Likely>');
  });

  it('deletes the person behind a valid request and reports status', async () => {
    const runtime = { db, channels: defaultChannels() };
    await receive(runtime, { workspaceId, channel: 'instagram', externalId: 'ig-123', text: 'hi' });
    await receive(runtime, {
      workspaceId,
      channel: 'instagram',
      externalId: 'ig-456',
      text: 'hello',
    });

    const res = await deletion(
      signRequest({ algorithm: 'HMAC-SHA256', user_id: 'ig-123', issued_at: 1 }, SECRET),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; confirmation_code: string };
    expect(body.url).toBe(
      `https://social.example.test/data-deletion?code=${body.confirmation_code}`,
    );

    const left = await db.execute<{ external_id: string }>(
      sql`select external_id from contact_identities order by external_id`,
    );
    expect(left.rows.map((r) => r.external_id)).toEqual(['ig-456']);

    const status = await app.inject({ url: `/data-deletion?code=${body.confirmation_code}` });
    expect(status.statusCode).toBe(200);
    expect(status.body).toContain('Data deleted');
    // The stored request keeps a hash, not the Instagram user id.
    const stored = await db.execute<{ external_id: string }>(
      sql`select external_id from deletion_requests`,
    );
    expect(stored.rows[0]?.external_id).not.toContain('ig-123');
  });

  it('rejects forged requests and unknown codes', async () => {
    expect(
      (await deletion(signRequest({ algorithm: 'HMAC-SHA256', user_id: 'x' }, 'not-the-secret')))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/data-deletion?code=nope' })).statusCode).toBe(404);
  });

  it('keeps the rest of the API JSON-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=o%40example.test&password=a+long+enough+password',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe.skipIf(!databaseUrl)('data deletion without a Meta app secret', () => {
  it('says the install isn’t configured', async () => {
    const config = { ...loadConfig({ NODE_ENV: 'test' }), databaseUrl: databaseUrl ?? '' };
    const { db, pool } = createDb(config.databaseUrl);
    const app = await buildApp({ db, config }, false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/meta/data-deletion',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'signed_request=abc.def',
    });
    expect(res.statusCode).toBe(503);
    await app.close();
    await pool.end();
  });
});
