import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { LEASE_SAFETY_MARGIN_MS, loadConfig, type Config, type Platform } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { MockPostRepository, MockPublisher } from '../publishers/mock.js';
import type { PublishRequest, PublishResult, SocialPublisher } from '../publishers/types.js';
import { failed, published } from '../publishers/types.js';
import { VariantRepository } from '../variants/repository.js';
import { PublishAttemptRepository } from './attempts.js';
import { JobRepository } from './repository.js';
import { idempotencyKey } from './slots.js';
import { PublishWorker, type WorkerHooks } from './worker.js';

let db: Db;
let jobs: JobRepository;
let attempts: PublishAttemptRepository;
let variants: VariantRepository;
let mockPosts: MockPostRepository;
let config: Config;

const SLOT = '2026-10-19T15:00:00.000Z';
const AFTER_SLOT = new Date('2026-10-19T15:00:10Z');

beforeEach(() => {
  db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO posts (id, source_type, title, body_md, created_at)
      VALUES (1, 'markdown', 't', 'b', '2026-10-19T00:00:00.000Z');
    INSERT INTO variants (id, post_id, platform, text, status, created_at, updated_at)
      VALUES (1, 1, 'x', 'Retries are cheap. Correctness is not.', 'approved',
              '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  `);
  jobs = new JobRepository(db);
  attempts = new PublishAttemptRepository(db);
  variants = new VariantRepository(db);
  mockPosts = new MockPostRepository(db);
  config = testConfig();
});

/**
 * A fixed config, not `loadConfig()`. The worker's behaviour must be pinned by the
 * test, not by whatever `.env` the machine happens to have, and `npm test` has to
 * pass on a fresh clone with no `.env` at all.
 */
function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    publicBaseUrl: 'http://localhost:3000',
    databaseFile: ':memory:',
    platforms: ['x'],
    publishers: { x: 'mock_x', linkedin: 'mock_linkedin', discord: 'discord' },
    discordWebhookUrl: undefined,
    discordGuildId: undefined,
    workerPollMs: 2_000,
    workerLeaseMs: 60_000,
    publishTimeoutMs: 10_000,
    maxPublishAttempts: 5,
    ...overrides,
  };
}

function scheduleJob(slot = SLOT, variantId = 1): number {
  return jobs.create({
    variantId,
    slotAt: slot,
    idempotencyKey: idempotencyKey(variantId, slot),
    adapter: 'mock_x',
  }).job.id;
}

function makeWorker(
  publisher: SocialPublisher,
  hooks: WorkerHooks = {},
  workerId = 'worker-a',
): PublishWorker {
  const publishers = new Map<Platform, SocialPublisher>([['x', publisher]]);
  return new PublishWorker({
    db,
    jobs,
    attempts,
    variants,
    publishers,
    config,
    workerId,
    hooks: { now: () => AFTER_SLOT, ...hooks },
  });
}

const realMock = (): MockPublisher => new MockPublisher('mock_x', db, 'http://localhost:3000');

/**
 * Puts a job into exactly the state a hard kill leaves behind: still `claimed`, lease
 * already expired, and an attempt still `in_flight`. The lease must be in the past
 * relative to the worker clock, or recovery correctly decides the job is still owned.
 */
function simulateHardKill(jobId: number): void {
  db.exec(`UPDATE jobs SET status = 'claimed', claimed_by = 'dead-worker',
                           lease_until = '2026-10-19T15:00:05.000Z' WHERE id = ${jobId}`);
  db.exec(`UPDATE publish_attempts SET outcome = 'in_flight', finished_at = NULL WHERE job_id = ${jobId}`);
}

/**
 * A clock that returns the scripted times in order, then `andThen` for ever.
 *
 * Used to freeze a worker mid-pass. The worker reads the clock once in
 * `recoverStaleClaims` and once in `claimOne`, so the first two readings are the
 * claim; every later reading is after the simulated freeze.
 */
function scriptedClock(script: Date[], andThen: Date): () => Date {
  let call = 0;
  return () => script[call++] ?? andThen;
}

/** An adapter that cannot dedupe, standing in for the Discord webhook. */
class NoDedupePublisher implements SocialPublisher {
  readonly name = 'fake_discord';
  readonly dedupesByKey = false;
  readonly target = 'fake';
  sends = 0;
  constructor(private readonly behaviour: (n: number) => PublishResult = () => published('m1', 'u1')) {}
  async publish(_request: PublishRequest): Promise<PublishResult> {
    this.sends += 1;
    return this.behaviour(this.sends);
  }
}

describe('the happy path', () => {
  it('publishes a due job once and marks the variant published', async () => {
    const id = scheduleJob();
    const processed = await makeWorker(realMock()).runOnce();

    assert.equal(processed, 1);
    assert.equal(jobs.findById(id)?.status, 'succeeded');
    assert.equal(variants.findById(1)?.status, 'published');
    assert.equal(attempts.countByOutcome(id, 'succeeded'), 1);
    assert.equal(mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)), 1);
  });

  it('records the message id and link in the history', async () => {
    const id = scheduleJob();
    await makeWorker(realMock()).runOnce();

    const [attempt] = attempts.listByJob(id);
    assert.equal(attempt?.outcome, 'succeeded');
    assert.ok(attempt?.externalId);
    assert.match(attempt?.externalUrl ?? '', /\/mock\/posts\/\d+$/);
  });

  it('does not publish a job before its slot', async () => {
    scheduleJob();
    const worker = makeWorker(realMock(), { now: () => new Date('2026-10-19T14:00:00Z') });
    assert.equal(await worker.runOnce(), 0);
  });

  it('refuses to publish a variant that is no longer approved', async () => {
    // Edited or rejected after scheduling. Publishing unapproved words is the one
    // thing the whole workflow exists to prevent.
    const id = scheduleJob();
    variants.updateStatus(1, 'approved', 'rejected');

    await makeWorker(realMock()).runOnce();

    assert.equal(jobs.findById(id)?.status, 'failed');
    assert.match(jobs.findById(id)?.lastError ?? '', /not approved/);
    assert.equal(mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)), 0);
  });
});

describe('probe 5: a crash between the send and the result write', () => {
  /**
   * The seam. `afterSend` throws exactly where the process could die: the adapter has
   * returned, the message exists, and nothing has been recorded yet. No process is
   * killed, so this is deterministic and a reviewer can rerun it.
   */
  it('leaves the attempt in_flight when the worker dies mid-publish', async () => {
    const id = scheduleJob();
    const publisher = realMock();

    await makeWorker(publisher, {
      afterSend: () => {
        throw new Error('simulated crash between send and record');
      },
    }).runOnce();

    // The message was sent, and the evidence of it is the in_flight attempt.
    assert.equal(mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)), 1, 'the message was sent');
    assert.equal(jobs.findById(id)?.status, 'unknown', 'an unexplained throw after sending is ambiguous');
    assert.equal(attempts.countByOutcome(id, 'succeeded'), 0, 'nothing was recorded as succeeded');
  });

  it('a restart after the crash results in exactly one published message', async () => {
    const id = scheduleJob();
    const publisher = realMock();

    // Pass 1: crash between the send and the record. The job is left claimed with an
    // in_flight attempt, which is the state a hard kill leaves behind.
    const crashing = makeWorker(publisher, {
      afterSend: () => {
        throw new Error('simulated crash');
      },
    });
    await crashing.runOnce();

    // The throw above parked the job, which is what an orderly failure does. A hard
    // kill leaves a different shape, so reproduce that exactly.
    simulateHardKill(id);

    // Pass 2: a fresh worker starts up and recovers.
    const restarted = makeWorker(publisher, {}, 'worker-b');
    const recovered = restarted.recoverStaleClaims();
    await restarted.runOnce();

    assert.equal(recovered, 1, 'the stale claim was recovered');
    assert.equal(
      mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)),
      1,
      'EXACTLY ONE message exists after the crash and restart',
    );
    assert.equal(jobs.findById(id)?.status, 'succeeded');
    assert.equal(
      attempts.countByOutcome(id, 'succeeded'),
      1,
      'the history shows exactly one successful publish',
    );
  });

  it('re-queues a job whose worker died BEFORE sending', async () => {
    const id = scheduleJob();
    // Claimed, lease expired, and no attempt row: nothing was sent.
    jobs.claimOne('dead-worker', 1_000, new Date('2026-10-19T15:00:00Z'));

    const worker = makeWorker(realMock(), {}, 'worker-b');
    assert.equal(worker.recoverStaleClaims(), 1);
    assert.equal(jobs.findById(id)?.status, 'pending');
    assert.match(jobs.findById(id)?.lastError ?? '', /never sent/);

    await worker.runOnce();
    assert.equal(mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)), 1);
  });

  it('parks a job as unknown when the adapter cannot dedupe', async () => {
    // The Discord case. A retry could post twice, so the system refuses to guess.
    const id = scheduleJob();
    const publisher = new NoDedupePublisher();
    const publishers = new Map<Platform, SocialPublisher>([['x', publisher]]);

    const crashing = new PublishWorker({
      db, jobs, attempts, variants, publishers, config, workerId: 'worker-a',
      hooks: {
        now: () => AFTER_SLOT,
        afterSend: () => {
          throw new Error('simulated crash');
        },
      },
    });
    await crashing.runOnce();

    simulateHardKill(id);

    const restarted = new PublishWorker({
      db, jobs, attempts, variants, publishers, config, workerId: 'worker-b',
      hooks: { now: () => AFTER_SLOT },
    });
    restarted.recoverStaleClaims();
    await restarted.runOnce();

    assert.equal(publisher.sends, 1, 'it must NOT send a second time');
    assert.equal(jobs.findById(id)?.status, 'unknown', 'parked for a human to resolve');
    assert.match(jobs.findById(id)?.lastError ?? '', /check the target and resolve/);
  });
});

describe('repeated publishing of one job', () => {
  it('cannot record two successes, because the database forbids it', async () => {
    const id = scheduleJob();
    await makeWorker(realMock()).runOnce();

    // Force the job back to pending, as a buggy retry or an operator might.
    db.exec(`UPDATE jobs SET status = 'pending', lease_until = NULL WHERE id = ${id}`);
    await makeWorker(realMock(), {}, 'worker-b').runOnce();

    assert.equal(attempts.countByOutcome(id, 'succeeded'), 1, 'still exactly one success');
    assert.equal(mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)), 1, 'still one message');
    assert.equal(jobs.findById(id)?.status, 'succeeded');
  });

  it('suppresses the send entirely when a success is already recorded', async () => {
    const id = scheduleJob();
    const publisher = new NoDedupePublisher();
    const publishers = new Map<Platform, SocialPublisher>([['x', publisher]]);
    const makeIt = (workerId: string) =>
      new PublishWorker({ db, jobs, attempts, variants, publishers, config, workerId, hooks: { now: () => AFTER_SLOT } });

    await makeIt('worker-a').runOnce();
    db.exec(`UPDATE jobs SET status = 'pending', lease_until = NULL WHERE id = ${id}`);
    await makeIt('worker-b').runOnce();

    assert.equal(publisher.sends, 1, 'the second pass must not reach the network at all');
    assert.match(jobs.findById(id)?.lastError ?? '', /retry suppressed/);
  });
});

describe('failure handling', () => {
  const publisherThat = (result: PublishResult): SocialPublisher => ({
    name: 'stub',
    dedupesByKey: false,
    target: 'stub',
    publish: async () => result,
  });

  it('settles a permanent failure without retrying', async () => {
    const id = scheduleJob();
    await makeWorker(publisherThat(failed('permanent', 'Invalid Form Body'))).runOnce();

    const job = jobs.findById(id);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.attempts, 1, 'no further attempts');
    assert.equal(attempts.countByOutcome(id, 'failed'), 1);
  });

  it('re-queues a retryable failure with backoff', async () => {
    const id = scheduleJob();
    await makeWorker(publisherThat(failed('retryable', 'rate limited'))).runOnce();

    const job = jobs.findById(id);
    assert.equal(job?.status, 'pending');
    assert.ok(job && job.runAfter > SLOT, 'run_after moved into the future');
    assert.equal(job?.attempts, 1, 'the used attempt is not given back');
  });

  it('parks an ambiguous failure when the adapter cannot dedupe', async () => {
    const id = scheduleJob();
    await makeWorker(publisherThat(failed('ambiguous', 'timed out after sending'))).runOnce();

    assert.equal(jobs.findById(id)?.status, 'unknown');
    assert.equal(attempts.countByOutcome(id, 'ambiguous'), 1);
  });

  it('retries an ambiguous failure when the adapter does dedupe', async () => {
    // Safe, because the target would absorb the repeat.
    const id = scheduleJob();
    const dedupes: SocialPublisher = {
      ...publisherThat(failed('ambiguous', 'timed out')),
      dedupesByKey: true,
    };
    await makeWorker(dedupes).runOnce();

    assert.equal(jobs.findById(id)?.status, 'pending');
  });

  it('gives up after the configured number of attempts', async () => {
    const id = scheduleJob();
    db.exec(`UPDATE jobs SET attempts = ${config.maxPublishAttempts} WHERE id = ${id}`);

    await makeWorker(publisherThat(failed('retryable', 'still failing'))).runOnce();

    assert.equal(jobs.findById(id)?.status, 'failed');
    assert.match(jobs.findById(id)?.lastError ?? '', /gave up after/);
  });

  it('redacts a webhook URL out of a stored error', async () => {
    const id = scheduleJob();
    const leaky = 'https://discord.com/api/webhooks/123456789/supersecrettoken';
    await makeWorker(publisherThat(failed('permanent', `failed posting to ${leaky}`))).runOnce();

    const stored = `${jobs.findById(id)?.lastError} ${attempts.listByJob(id)[0]?.error}`;
    assert.ok(!stored.includes('supersecrettoken'), `secret reached the database: ${stored}`);
  });
});

describe('the lease', () => {
  it('releases a job without sending when too little lease remains', async () => {
    // What a long process pause looks like: the claim is still ours on paper, but
    // another worker may already consider the job abandoned. Sending late risks a
    // duplicate; releasing without sending cannot.
    const id = scheduleJob();
    const publisher = new NoDedupePublisher();
    const publishers = new Map<Platform, SocialPublisher>([['x', publisher]]);

    const worker = new PublishWorker({
      db, jobs, attempts, variants, publishers, config, workerId: 'worker-a',
      hooks: {
        // Recovery and the claim happen at the slot; everything after that happens
        // one second before the lease expires, as if the process had been frozen.
        now: scriptedClock(
          [AFTER_SLOT, AFTER_SLOT],
          new Date(AFTER_SLOT.getTime() + config.workerLeaseMs - 1_000),
        ),
      },
    });
    await worker.runOnce();

    assert.equal(publisher.sends, 0, 'nothing may be sent with an almost-expired lease');
    assert.equal(jobs.findById(id)?.status, 'pending');
    assert.match(jobs.findById(id)?.lastError ?? '', /not sent: only/);
    assert.equal(attempts.listByJob(id).length, 0, 'no attempt row, because nothing was attempted');
  });

  it('publishes normally at the smallest lease the config allows', async () => {
    // Regression. The pre-send check once used the same constant as the boot check,
    // so a lease of exactly `timeout + margin` was already a few milliseconds short
    // the instant it was claimed. Every job was released unsent and retried until a
    // millisecond boundary happened to line up. The earlier tests all used the 60s
    // default lease, so none of them noticed.
    config = testConfig({ publishTimeoutMs: 10_000, workerLeaseMs: 10_000 + LEASE_SAFETY_MARGIN_MS });
    const id = scheduleJob();
    const publisher = realMock();

    await makeWorker(publisher).runOnce();

    assert.equal(jobs.findById(id)?.status, 'succeeded');
    assert.equal(jobs.findById(id)?.attempts, 1, 'it must publish on the first attempt, not after retries');
    assert.equal(mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)), 1);
  });

  it('refuses to start when the lease cannot outlast the publish timeout', () => {
    // The config guard itself, so this one does exercise loadConfig. PLATFORMS is
    // narrowed to x so no webhook is required and the test needs no .env.
    const saved = { ...process.env };
    try {
      process.env.PLATFORMS = 'x';
      process.env.PUBLISHER_X = 'mock_x';
      process.env.PUBLISH_TIMEOUT_MS = '10000';
      process.env.WORKER_LEASE_MS = '11000';
      assert.throws(() => loadConfig(), /must be at least PUBLISH_TIMEOUT_MS/);

      // And the boundary is accepted, so the rule is a floor and not a trap.
      process.env.WORKER_LEASE_MS = String(10_000 + LEASE_SAFETY_MARGIN_MS);
      assert.doesNotThrow(() => loadConfig());
    } finally {
      for (const key of ['PLATFORMS', 'PUBLISHER_X', 'PUBLISH_TIMEOUT_MS', 'WORKER_LEASE_MS']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe('two workers racing', () => {
  it('publishes a job exactly once even when both poll together', async () => {
    const id = scheduleJob();
    const publisher = realMock();

    await Promise.all([
      makeWorker(publisher, {}, 'worker-a').runOnce(),
      makeWorker(publisher, {}, 'worker-b').runOnce(),
    ]);

    assert.equal(mockPosts.countByKey('mock_x', idempotencyKey(1, SLOT)), 1);
    assert.equal(attempts.countByOutcome(id, 'succeeded'), 1);
  });
});
