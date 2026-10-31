import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  PUBLIC_URL: z.url().default('http://localhost:8110'),
  APP_SECRET: z.string().optional(),
  BACKUP_DIR: z.string().default('/backups'),
  BACKUP_KEEP: z.coerce.number().int().positive().default(14),
  BACKUP_CRON: z.string().default('30 3 * * *'),
  TZ: z.string().default('UTC'),
  APP_VERSION: z.string().default('dev'),
  /** Meta app secret: verifies Meta's signed callbacks (data deletion now, webhooks in Phase 2). */
  META_APP_SECRET: z.string().optional(),
  /** Shown on the public privacy page as the way to reach whoever runs this install. */
  PRIVACY_CONTACT: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = envSchema.parse(env);
  const production = e.NODE_ENV === 'production';

  // In development the database runs from docker-compose.dev.yml on 127.0.0.1:55432.
  const databaseUrl =
    e.DATABASE_URL ??
    (production
      ? undefined
      : `postgres://switchboard:${encodeURIComponent(e.POSTGRES_PASSWORD ?? 'switchboard')}@127.0.0.1:55432/switchboard`);
  if (!databaseUrl) throw new Error('DATABASE_URL is required in production');

  if (production && (!e.APP_SECRET || e.APP_SECRET.length < 32)) {
    throw new Error('APP_SECRET must be at least 32 characters (run ./scripts/init-env.sh)');
  }

  return {
    production,
    host: e.HOST,
    port: e.PORT,
    databaseUrl,
    publicUrl: e.PUBLIC_URL.replace(/\/$/, ''),
    cookieSecure: e.PUBLIC_URL.startsWith('https://'),
    appSecret: e.APP_SECRET ?? 'dev-only-secret-dev-only-secret-dev-only',
    backupDir: e.BACKUP_DIR,
    backupKeep: e.BACKUP_KEEP,
    backupCron: e.BACKUP_CRON,
    timeZone: e.TZ,
    version: e.APP_VERSION,
    metaAppSecret: e.META_APP_SECRET || undefined,
    privacyContact: e.PRIVACY_CONTACT || undefined,
    migrationsDir: resolve(here, '../drizzle'),
    webDist: resolve(here, '../../web/dist'),
  };
}
