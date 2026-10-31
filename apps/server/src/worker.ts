import { PgBoss } from 'pg-boss';
import { listBackups, runBackup } from './backup';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { log, logError } from './log';
import { defaultChannels } from './runtime/channels';
import { deliverStale, type RuntimeDeps, wakeDue } from './runtime/runtime';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
const runtime: RuntimeDeps = { db, channels: defaultChannels(), log };

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

// Flow timers: delays and reply timeouts live on the runs themselves (wake_at), written in the
// same transaction as the run's state, so a timer can never get out of step with its run.
const TICK_MS = 5_000;
const BATCH = 50;
let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function tick() {
  try {
    for (let batches = 0; batches < 10 && !stopping; batches++) {
      if ((await wakeDue(runtime, BATCH)) < BATCH) break;
    }
    if (!stopping) await deliverStale(runtime);
  } catch (err) {
    logError('flow timer tick failed', err);
  }
  if (!stopping) timer = setTimeout(tick, TICK_MS);
}
void tick();

log('worker started', { backupCron: config.backupCron, timeZone: config.timeZone });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log('worker shutting down', { signal });
    stopping = true;
    clearTimeout(timer);
    await boss.stop({ graceful: true });
    await pool.end();
    process.exit(0);
  });
}
