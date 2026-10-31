import { eq } from 'drizzle-orm';
import { hashPassword } from './auth/password';
import { runBackup } from './backup';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { sessions, users } from './db/schema';
import { log, logError } from './log';

// Server-side commands, run inside the app container:
//   docker compose exec app node dist/cli.js backup
//   docker compose exec app node dist/cli.js reset-password you@example.com

const [command, arg] = process.argv.slice(2);

/** Reads a line without echoing it (a terminal), or the next line of piped input. */
function askHidden(prompt: string, piped: string[]): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve(piped.shift() ?? '');
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130); // Ctrl+C
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/);
}

/** For a forgotten password: sets a new one and signs that account out everywhere. */
async function resetPassword(email: string | undefined) {
  const { db, pool } = createDb(loadConfig().databaseUrl);
  try {
    const all = await db.select({ id: users.id, email: users.email }).from(users);
    const user = email
      ? all.find((u) => u.email === email.trim().toLowerCase())
      : all.length === 1
        ? all[0]
        : undefined;
    if (!user) {
      console.error(
        email
          ? `No account with the email ${email}. Accounts: ${all.map((u) => u.email).join(', ') || 'none'}`
          : `Say which account: node dist/cli.js reset-password <email> (accounts: ${all.map((u) => u.email).join(', ')})`,
      );
      process.exitCode = 1;
      return;
    }
    const piped = await readPiped();
    const password = await askHidden(
      `New password for ${user.email} (at least 10 characters): `,
      piped,
    );
    if (password.length < 10) {
      console.error('That’s shorter than 10 characters. Nothing was changed.');
      process.exitCode = 1;
      return;
    }
    if ((await askHidden('Type it again: ', piped)) !== password) {
      console.error('The two didn’t match. Nothing was changed.');
      process.exitCode = 1;
      return;
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, user.id));
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    console.log(
      `Password updated for ${user.email}. Sign in with it now; other sessions were signed out.`,
    );
  } finally {
    await pool.end();
  }
}

switch (command) {
  case 'backup': {
    try {
      log('backup written', await runBackup(loadConfig()));
    } catch (err) {
      logError('backup failed', err);
      process.exit(1);
    }
    break;
  }
  case 'reset-password':
    await resetPassword(arg);
    break;
  default:
    console.error('usage: node dist/cli.js backup | reset-password <email>');
    process.exit(1);
}
