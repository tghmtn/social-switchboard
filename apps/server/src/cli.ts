import { runBackup } from './backup';
import { loadConfig } from './config';
import { log, logError } from './log';

const [command] = process.argv.slice(2);

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
  default:
    console.error('usage: node dist/cli.js backup');
    process.exit(1);
}
