import { PgBoss } from 'pg-boss';
import { aiRouter, aiStepper } from './ai/flow-step';
import { listBackups, runBackup } from './backup';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { processWebhookEvents } from './instagram/events';
import { forgetSentIds, resumeDue } from './instagram/takeover';
import { refreshExpiringTokens } from './instagram/tokens';
import { log, logError } from './log';
import { notifier } from './notify';
import { allChannels } from './runtime/registry';
import { deliverStale, type RuntimeDeps, wakeDue } from './runtime/runtime';
import { wakeSnoozed } from './runtime/snooze';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
const runtime: RuntimeDeps = {
  db,
  channels: allChannels(db, config.appSecret),
  log,
  notify: notifier({ db, appSecret: config.appSecret, publicUrl: config.publicUrl, log }),
  aiTurn: aiStepper({ db, appSecret: config.appSecret, log }),
  aiRoute: aiRouter({ db, appSecret: config.appSecret, log }),
};

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

// Instagram tokens last 60 days; keep them fresh.
const TOKENS = 'instagram-token-refresh';
await boss.createQueue(TOKENS);
await boss.schedule(TOKENS, '15 4 * * *', null, { tz: config.timeZone });
await boss.work(TOKENS, async () => {
  await refreshExpiringTokens(db, config.appSecret, log);
});

// A fresh install gets its first backup right away instead of waiting for the nightly run.
if ((await listBackups(config.backupDir)).length === 0) await boss.send(BACKUP);

// Flow timers: delays and reply timeouts live on the runs themselves (wake_at), written in the
// same transaction as the run's state, so a timer can never get out of step with its run.
const TICK_MS = 5_000;
const BATCH = 50;
let stopping = false;
let lastForget = 0;
let timer: NodeJS.Timeout | undefined;

async function tick() {
  try {
    for (let batches = 0; batches < 10 && !stopping; batches++) {
      if ((await wakeDue(runtime, BATCH)) < BATCH) break;
    }
    if (!stopping) await deliverStale(runtime);
    // Pauses from a person replying in Instagram end by themselves.
    if (!stopping) await resumeDue(db);
    // Snoozed conversations whose time has come: tell the person.
    if (!stopping) await wakeSnoozed(db, runtime.notify);
    if (!stopping && Date.now() - lastForget > 3_600_000) {
      await forgetSentIds(db);
      lastForget = Date.now();
    }
    // Webhook deliveries the API server couldn't finish (it processes them right away normally).
    if (!stopping) await processWebhookEvents({ db, runtime, appSecret: config.appSecret });
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
