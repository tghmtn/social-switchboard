import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config';

const execFileAsync = promisify(execFile);
const PREFIX = 'social-switchboard-';
const SUFFIX = '.dump';

/** Backup file names, oldest first (the ISO timestamp in the name sorts chronologically). */
export async function listBackups(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX)).sort();
}

/** Dumps the database with pg_dump (custom format; restore with pg_restore) and prunes old dumps. */
export async function runBackup(config: Pick<Config, 'databaseUrl' | 'backupDir' | 'backupKeep'>) {
  await mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(config.backupDir, `${PREFIX}${stamp}${SUFFIX}`);
  const partial = `${file}.partial`;

  // Pass the password via PGPASSWORD so it doesn't show up in the process list.
  const url = new URL(config.databaseUrl);
  const password = decodeURIComponent(url.password);
  url.password = '';

  try {
    await execFileAsync(
      'pg_dump',
      ['--format=custom', '--no-owner', '--file', partial, '--dbname', url.toString()],
      { env: { ...process.env, PGPASSWORD: password } },
    );
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, file);

  const all = await listBackups(config.backupDir);
  const expired = all.slice(0, Math.max(0, all.length - config.backupKeep));
  await Promise.all(expired.map((name) => rm(join(config.backupDir, name))));

  return { file, bytes: (await stat(file)).size, pruned: expired.length };
}
