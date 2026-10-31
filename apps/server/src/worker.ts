import { PgBoss } from 'pg-boss';
import { listBackups, runBackup } from './backup';
import { loadConfig } from './config';
import { log, logError } from './log';

const config = loadConfig();
const boss = new PgBoss(config.databaseUrl);
boss.on('error', (err) => logError('pg-boss error', err));
await boss.start();

const BACKUP = 'backup';
await boss.createQueue(BACKUP);
await boss.schedule(BACKUP, config.backupCron, null, { tz: config.timeZone });
await boss.work(BACKUP, async () => {
  const result = await runBackup(config);
  log('backup written', result);
});

// A fresh install gets its first backup right away instead of waiting for the nightly run.
if ((await listBackups(config.backupDir)).length === 0) await boss.send(BACKUP);

log('worker started', { backupCron: config.backupCron, timeZone: config.timeZone });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log('worker shutting down', { signal });
    await boss.stop({ graceful: true });
    process.exit(0);
  });
}
