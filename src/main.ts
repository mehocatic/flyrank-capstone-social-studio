import process from 'node:process';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createApp } from './http/app.js';
import { PublishAttemptRepository } from './jobs/attempts.js';
import { JobRepository } from './jobs/repository.js';
import { PublishWorker } from './jobs/worker.js';
import { createPublisherRegistry } from './publishers/index.js';
import { VariantRepository } from './variants/repository.js';
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
    const worker = new PublishWorker({
      db,
      jobs: new JobRepository(db),
      attempts: new PublishAttemptRepository(db),
      variants: new VariantRepository(db),
      publishers: createPublisherRegistry(config, db),
      config,
      // No hooks: the afterSend seam exists for tests and is never set here.
    });
    worker.start();

    process.on('SIGINT', () => {
      // Finishes the job in flight, then exits. A hard kill (SIGKILL, or closing the
      // terminal) skips this, which is what probe 5 exercises: lease recovery.
      void worker.stop().then(() => {
        if (!runApi) {
          db.close();
          process.exit(0);
        }
      });
    });
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
