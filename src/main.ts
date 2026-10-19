import process from 'node:process';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createApp } from './http/app.js';
import { installFatalHandlers } from './process-guards.js';
import { redact } from './redact.js';

/**
 * Single entry point. With no flag it runs the API and (later) the worker in one
 * process, so a stranger needs one command. `--api` / `--worker` split them, which
 * is what probe 5 needs: kill the worker while the API keeps serving history.
 */
// Registered before anything else runs, so no failure during startup can print a
// secret through Node's own default reporting.
installFatalHandlers();

const flags = new Set(process.argv.slice(2));
const runApi = flags.has('--api') || !flags.has('--worker');
const runWorker = flags.has('--worker') || !flags.has('--api');

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databaseFile);
  console.log(`[boot] database ${config.databaseFile}`);
  console.log(`[boot] platforms ${config.platforms.join(', ')}`);

  if (runApi) {
    const server = createApp({ config, db }).listen(config.port, () => {
      console.log(`[api] listening on http://localhost:${config.port}`);
    });
    process.on('SIGINT', () => {
      console.log('\n[shutdown] stopping');
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }

  if (runWorker) {
    console.log('[worker] not implemented yet (phase 5)');
  }
}

try {
  main();
} catch (error) {
  // A bad .env should fail loudly at boot with a readable reason, not a stack trace.
  // Redacted for the same reason as the API error log: a boot failure can carry a
  // configured URL in its message.
  console.error(`[boot] failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
}
