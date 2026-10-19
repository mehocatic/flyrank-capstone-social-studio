import process from 'node:process';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { PostRepository } from './posts/repository.js';
import { JobRepository } from './jobs/repository.js';
import { VariantRepository } from './variants/repository.js';
import { VariantService } from './variants/service.js';
import { installFatalHandlers } from './process-guards.js';
import { redact } from './redact.js';

/**
 * Sample data, so a reviewer has something to work with immediately: one post, one
 * approved variant per configured platform, and the exact commands to try next.
 *
 * Deliberately not a test fixture. It goes through the same services the API uses,
 * so if generation or validation is broken, seeding fails too rather than quietly
 * inserting rows the application would have refused.
 */

const SAMPLE_MARKDOWN = `# Publish exactly once, even when the network lies

A retry after a timeout is the oldest way to create a duplicate post. The fix is not a
bigger timeout, it is an idempotency key that the database enforces.

Claim the job before you send it, write the attempt down first, and let a unique index
refuse the second success. What remains is a small window against an external API with
no idempotency support. You cannot close it, so you choose which way to fail, and you
say so out loud.
`;

function main(): void {
  installFatalHandlers();
  const config = loadConfig();
  const db = openDatabase(config.databaseFile);

  const posts = new PostRepository(db);
  const variants = new VariantRepository(db);
  const variantService = new VariantService(db, variants, new JobRepository(db), config);

  const post = posts.insert({
    sourceType: 'markdown',
    sourceUrl: null,
    title: 'Publish exactly once, even when the network lies',
    bodyMd: SAMPLE_MARKDOWN,
    tags: ['idempotency', 'backend', 'sqlite', 'nodejs'],
  });
  console.log(`\nPost ${post.id}: "${post.title}"`);

  const { created, skipped } = variantService.generate(post);
  for (const variant of created) {
    variantService.setStatus(variant, 'approved');
    const described = variantService.describe(variant);
    console.log(
      `  variant ${variant.id} [${variant.platform}] approved, ` +
        `${described.length}/${described.limit} characters` +
        (variant.shapingNotes.length > 0 ? `, ${variant.shapingNotes.length} shaping note(s)` : ''),
    );
  }
  for (const entry of skipped) {
    console.log(`  ${entry.platform}: skipped (${entry.reason})`);
  }

  const first = created[0];
  console.log(`\nAdapters in use: ${JSON.stringify(config.publishers)}`);
  console.log('\nTry next:');
  console.log(`  curl localhost:${config.port}/posts/${post.id}/variants`);
  if (first) {
    console.log(
      `  curl -X POST localhost:${config.port}/variants/${first.id}/schedule ` +
        `-H 'content-type: application/json' -d '{"at":"+2m"}'`,
    );
  }
  console.log(`  open http://localhost:${config.port}/ui/history`);
  console.log('\nThe variants are approved, so they are ready to schedule. Start the app with: npm start\n');

  db.close();
}

try {
  main();
} catch (error) {
  console.error(`[seed] failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
}
