import { randomUUID } from 'node:crypto';
import { LEASE_COMMIT_ALLOWANCE_MS, type Config, type Platform } from '../config.js';
import { transaction, type Db } from '../db/index.js';
import type { SocialPublisher } from '../publishers/types.js';
import { redact, redactError } from '../redact.js';
import type { VariantRepository } from '../variants/repository.js';
import type { PublishAttemptRepository } from './attempts.js';
import type { Job, JobRepository } from './repository.js';

/**
 * Test seams. Unused in production: `createWorker` leaves them undefined.
 *
 * `afterSend` is the important one. It runs **after the adapter returns and before
 * the result is committed**, which is the one gap that cannot be made atomic and the
 * only place a crash is interesting. A test throws from it to simulate the process
 * dying exactly there, deterministically and without killing anything.
 */
export interface WorkerHooks {
  afterSend?: (context: { job: Job; attemptId: number }) => void | Promise<void>;
  /** Overrides the clock, so lease expiry can be tested without waiting. */
  now?: () => Date;
}

export interface WorkerDeps {
  db: Db;
  jobs: JobRepository;
  attempts: PublishAttemptRepository;
  variants: VariantRepository;
  publishers: Map<Platform, SocialPublisher>;
  config: Config;
  workerId?: string;
  hooks?: WorkerHooks;
}

export class PublishWorker {
  private readonly workerId: string;
  private readonly hooks: WorkerHooks;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /** Resolves when the job in flight has finished, so shutdown can wait for it. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly deps: WorkerDeps) {
    this.workerId = deps.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.hooks = deps.hooks ?? {};
  }

  get id(): string {
    return this.workerId;
  }

  private now(): Date {
    return this.hooks.now?.() ?? new Date();
  }

  /**
   * Re-queues or parks jobs whose worker died while holding them.
   *
   * Runs at startup and before every poll. This is what makes a restart continue a
   * batch rather than stranding it, and it is the whole of probe 5's recovery path.
   */
  recoverStaleClaims(): number {
    const stale = this.deps.jobs.listExpiredClaims(this.now().toISOString());
    let recovered = 0;

    for (const job of stale) {
      const attempt = this.deps.attempts.findInFlight(job.id);

      if (!attempt) {
        // No in-flight attempt, so the worker died *before* calling the adapter.
        // Nothing was sent: safe to run again.
        this.deps.jobs.release(job.id, job.slotAt, 'recovered: claimed but never sent');
        console.log(`[worker] job ${job.id} recovered (never sent), back to pending`);
        recovered++;
        continue;
      }

      // An attempt was in flight, so the message may or may not exist. The adapter
      // decides what is safe, because only it knows whether a repeat is absorbed.
      const publisher = this.publisherFor(job);

      if (publisher?.dedupesByKey) {
        this.deps.attempts.finish(
          attempt.id,
          'ambiguous',
          'worker died mid-send; retried because this adapter dedupes by idempotency key',
        );
        this.deps.jobs.release(job.id, job.slotAt, 'recovered: retried, adapter dedupes by key');
        console.log(`[worker] job ${job.id} recovered (may have sent), retrying: adapter dedupes`);
      } else {
        // Discord. A retry could post twice, so the system refuses to guess and a
        // human decides via POST /jobs/:id/resolve.
        this.deps.attempts.finish(
          attempt.id,
          'ambiguous',
          'worker died mid-send and this adapter cannot dedupe; parked for a human to resolve',
        );
        this.deps.jobs.settle(
          job.id,
          'unknown',
          'worker died between sending and recording the result; check the target and resolve',
        );
        console.log(`[worker] job ${job.id} parked as unknown: cannot retry safely`);
      }
      recovered++;
    }
    return recovered;
  }

  /** One pass: recover, then publish every due job. Returns how many were processed. */
  async runOnce(): Promise<number> {
    this.recoverStaleClaims();

    let processed = 0;
    for (;;) {
      const job = this.deps.jobs.claimOne(this.workerId, this.deps.config.workerLeaseMs, this.now());
      if (!job) break;

      this.inFlight = this.publish(job);
      await this.inFlight;
      processed++;

      // Stop claiming once shutdown was requested, but only between jobs: the job
      // already in flight is always finished first.
      if (!this.running && this.timer === undefined) break;
    }
    return processed;
  }

  /**
   * Publishes one claimed job. The order of these steps is the entire guarantee.
   */
  private async publish(job: Job): Promise<void> {
    const publisher = this.publisherFor(job);
    if (!publisher) {
      this.deps.jobs.settle(
        job.id,
        'failed',
        `no adapter configured for platform of variant ${job.variantId}`,
        this.workerId,
      );
      return;
    }

    const variant = this.deps.variants.findById(job.variantId);
    if (!variant) {
      this.deps.jobs.settle(job.id, 'failed', `variant ${job.variantId} no longer exists`, this.workerId);
      return;
    }
    if (variant.status !== 'approved' && variant.status !== 'published') {
      // The variant was edited or rejected after the job was created. Publishing
      // unapproved words is the one thing this system exists to prevent.
      this.deps.jobs.settle(
        job.id,
        'failed',
        `variant ${variant.id} is ${variant.status}, not approved, so it was not published`,
        this.workerId,
      );
      return;
    }

    // Already recorded as published: a retry must never send again. The database
    // index enforces this too, but failing here avoids the pointless send.
    if (this.deps.attempts.hasSucceeded(job.id)) {
      this.deps.jobs.settle(job.id, 'succeeded', 'already published; retry suppressed', this.workerId);
      return;
    }

    // Pre-send lease check. If this process was paused long enough that the lease is
    // nearly up, another worker may already consider the job abandoned. Releasing
    // without sending is always safe; sending late is not.
    const remainingLease = this.remainingLeaseMs(job);
    const required = this.deps.config.publishTimeoutMs + LEASE_COMMIT_ALLOWANCE_MS;
    if (remainingLease < required) {
      this.deps.jobs.release(
        job.id,
        job.slotAt,
        `not sent: only ${remainingLease}ms of lease left, ${required}ms required`,
        this.workerId,
      );
      console.warn(`[worker] job ${job.id} released without sending: lease too short`);
      return;
    }

    // Step 1: write the attempt as in_flight, and commit it, BEFORE sending. If the
    // process dies during the send, this row is the only evidence it may have landed.
    const attempt = this.deps.attempts.startAttempt(job.id, job.attempts, publisher.name);

    let result;
    try {
      // Step 2: send.
      result = await publisher.publish({
        idempotencyKey: job.idempotencyKey,
        platform: variant.platform,
        text: variant.text,
      });

      // Step 3: the uncloseable gap. A test throws here to simulate a crash exactly
      // between the send returning and the result being committed.
      await this.hooks.afterSend?.({ job, attemptId: attempt.id });
    } catch (error) {
      // An unexpected throw from the adapter or the hook. The send may have happened,
      // so this is ambiguous by definition and is treated as such.
      const message = redactError(error);
      this.deps.attempts.finish(attempt.id, 'ambiguous', `threw after sending: ${message}`);
      this.deps.jobs.settle(job.id, 'unknown', `threw after sending: ${message}`, this.workerId);
      console.error(`[worker] job ${job.id} threw after sending, parked as unknown: ${message}`);
      return;
    }

    // Step 4: record the outcome.
    if (result.ok) {
      // One transaction: the attempt, the job and the variant move together, so no
      // reader ever sees a published message with an unsettled job.
      transaction(this.deps.db, () => {
        this.deps.attempts.finishSucceeded(attempt.id, result.externalId, result.url);
        this.deps.jobs.settle(job.id, 'succeeded', null, this.workerId);
        this.deps.variants.updateStatus(variant.id, variant.status, 'published');
      });
      const note = result.deduplicated ? ' (absorbed by the target as a duplicate)' : '';
      console.log(`[worker] job ${job.id} published via ${publisher.name} as ${result.externalId}${note}`);
      return;
    }

    this.recordFailure(job, attempt.id, publisher, result.kind, result.error);
  }

  private recordFailure(
    job: Job,
    attemptId: number,
    publisher: SocialPublisher,
    kind: 'retryable' | 'permanent' | 'ambiguous',
    error: string,
  ): void {
    const safeError = redact(error);

    if (kind === 'permanent') {
      this.deps.attempts.finish(attemptId, 'failed', safeError);
      this.deps.jobs.settle(job.id, 'failed', safeError, this.workerId);
      console.warn(`[worker] job ${job.id} failed permanently: ${safeError}`);
      return;
    }

    if (kind === 'ambiguous' && !publisher.dedupesByKey) {
      // The honest case. Retrying could post twice, so a human decides.
      this.deps.attempts.finish(attemptId, 'ambiguous', safeError);
      this.deps.jobs.settle(job.id, 'unknown', safeError, this.workerId);
      console.warn(`[worker] job ${job.id} ambiguous and not safe to retry, parked: ${safeError}`);
      return;
    }

    // Retryable, or ambiguous against an adapter that dedupes by key.
    const outcome = kind === 'ambiguous' ? 'ambiguous' : 'failed';
    this.deps.attempts.finish(attemptId, outcome, safeError);

    if (job.attempts >= this.deps.config.maxPublishAttempts) {
      this.deps.jobs.settle(
        job.id,
        kind === 'ambiguous' ? 'unknown' : 'failed',
        `gave up after ${job.attempts} attempts: ${safeError}`,
        this.workerId,
      );
      console.warn(`[worker] job ${job.id} gave up after ${job.attempts} attempts`);
      return;
    }

    const runAfter = this.backoffFrom(job.attempts);
    this.deps.jobs.release(job.id, runAfter, safeError, this.workerId);
    console.log(`[worker] job ${job.id} retrying after ${runAfter} (attempt ${job.attempts})`);
  }

  /** Exponential backoff: 2s, 4s, 8s, 16s, 32s, capped at 5 minutes. */
  private backoffFrom(attempts: number): string {
    const delayMs = Math.min(2 ** attempts * 1_000, 300_000);
    return new Date(this.now().getTime() + delayMs).toISOString();
  }

  private remainingLeaseMs(job: Job): number {
    if (!job.leaseUntil) return 0;
    return new Date(job.leaseUntil).getTime() - this.now().getTime();
  }

  private publisherFor(job: Job): SocialPublisher | undefined {
    const variant = this.deps.variants.findById(job.variantId);
    return variant ? this.deps.publishers.get(variant.platform) : undefined;
  }

  /** Starts polling. Returns immediately; use `stop()` to shut down cleanly. */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[worker] ${this.workerId} started, polling every ${this.deps.config.workerPollMs}ms`);

    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (error) {
        // A worker must not die because one pass failed, or nothing would ever publish.
        console.error(`[worker] poll failed: ${redactError(error)}`);
      }
      if (this.running) this.timer = setTimeout(tick, this.deps.config.workerPollMs);
    };
    void tick();
  }

  /**
   * Stops claiming new jobs and waits for the one in flight.
   *
   * A clean stop is not what probe 5 tests: that needs a hard kill, where this never
   * runs and lease recovery does the work instead.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    console.log(`[worker] ${this.workerId} stopped`);
  }
}
