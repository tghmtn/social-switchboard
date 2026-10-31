import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);

// Only the API server migrates; the worker waits for it to be healthy before starting.
await runMigrations(db, config.migrationsDir);

const app = await buildApp({ db, config });
await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
