import type { Db } from '../db/index.js';
import { execute, isUniqueViolation, nowIso, queryAll, queryOne } from '../db/index.js';

export const JOB_STATUSES = [
  'pending',
  'claimed',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: number;
  variantId: number;
  slotAt: string;
  idempotencyKey: string;
  status: JobStatus;
  adapter: string;
  attempts: number;
  runAfter: string;
  claimedBy: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: number;
  variant_id: number;
  slot_at: string;
  idempotency_key: string;
  status: JobStatus;
  adapter: string;
  attempts: number;
  run_after: string;
  claimed_by: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    variantId: row.variant_id,
    slotAt: row.slot_at,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    adapter: row.adapter,
    attempts: row.attempts,
    runAfter: row.run_after,
    claimedBy: row.claimed_by,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateJob {
  variantId: number;
  slotAt: string;
  idempotencyKey: string;
  adapter: string;
}

export interface CreateJobOutcome {
  job: Job;
  /** False when the job already existed, so the caller can answer 200 instead of 201. */
  created: boolean;
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  /**
   * Creates the job, or returns the existing one for the same variant and slot.
   *
   * The first line of the idempotency guarantee. Uniqueness is decided by the
   * database, not by a preceding SELECT, so two simultaneous schedule requests cannot
   * both pass a check and insert. The loser catches the constraint violation and
   * reads the winner's row.
   */
  create(input: CreateJob): CreateJobOutcome {
    const now = nowIso();
    try {
      const row = queryOne<JobRow>(
        this.db,
        `INSERT INTO jobs (variant_id, slot_at, idempotency_key, status, adapter,
                           attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?)
         RETURNING *`,
        input.variantId,
        input.slotAt,
        input.idempotencyKey,
        input.adapter,
        input.slotAt, // run_after starts at the slot; backoff pushes it later
        now,
        now,
      );
      if (!row) throw new Error('INSERT ... RETURNING returned no row');
      return { job: toJob(row), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = this.findByKey(input.idempotencyKey);
      if (!existing) {
        throw new Error(`UNIQUE violation for ${input.idempotencyKey} but no row found`);
      }
      return { job: existing, created: false };
    }
  }

  findById(id: number): Job | undefined {
    const row = queryOne<JobRow>(this.db, 'SELECT * FROM jobs WHERE id = ?', id);
    return row ? toJob(row) : undefined;
  }

  findByKey(key: string): Job | undefined {
    const row = queryOne<JobRow>(this.db, 'SELECT * FROM jobs WHERE idempotency_key = ?', key);
    return row ? toJob(row) : undefined;
  }

  listAll(limit = 100): Job[] {
    return queryAll<JobRow>(this.db, 'SELECT * FROM jobs ORDER BY id DESC LIMIT ?', limit).map(toJob);
  }

  listByVariant(variantId: number): Job[] {
    return queryAll<JobRow>(
      this.db,
      'SELECT * FROM jobs WHERE variant_id = ? ORDER BY slot_at',
      variantId,
    ).map(toJob);
  }

  /** Pending jobs whose time has come. Read-only: claiming is a separate, atomic step. */
  listDue(now = nowIso(), limit = 10): Job[] {
    return queryAll<JobRow>(
      this.db,
      `SELECT * FROM jobs
       WHERE status = 'pending' AND run_after <= ?
       ORDER BY run_after, id
       LIMIT ?`,
      now,
      limit,
    ).map(toJob);
  }

  /**
   * Takes ownership of one due job, atomically.
   *
   * The `WHERE status = 'pending'` inside a single UPDATE is what makes this safe:
   * SQLite serialises writers, so of two workers racing for the same row exactly one
   * matches and the other updates nothing. There is no window between checking and
   * claiming, which a SELECT-then-UPDATE would have.
   *
   * `attempts` increments here, at the claim, not after a send. A job that crashes
   * mid-publish has still used an attempt, so a crash loop cannot retry for ever.
   */
  claimOne(workerId: string, leaseMs: number, now = new Date()): Job | undefined {
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const nowStr = now.toISOString();

    const row = queryOne<JobRow>(
      this.db,
      `UPDATE jobs
          SET status = 'claimed',
              claimed_by = ?,
              lease_until = ?,
              attempts = attempts + 1,
              updated_at = ?
        WHERE id = (
          SELECT id FROM jobs
           WHERE status = 'pending' AND run_after <= ?
           ORDER BY run_after, id
           LIMIT 1
        )
       RETURNING *`,
      workerId,
      leaseUntil,
      nowStr,
      nowStr,
    );
    return row ? toJob(row) : undefined;
  }

  /** Jobs whose lease has expired: their worker died while holding them. */
  listExpiredClaims(now = nowIso()): Job[] {
    return queryAll<JobRow>(
      this.db,
      `SELECT * FROM jobs WHERE status = 'claimed' AND lease_until <= ? ORDER BY id`,
      now,
    ).map(toJob);
  }

  /** Returns a job to the queue, optionally delayed by backoff. */
  release(id: number, runAfter: string, lastError: string | null): boolean {
    const { changes } = execute(
      this.db,
      `UPDATE jobs
          SET status = 'pending', claimed_by = NULL, lease_until = NULL,
              run_after = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed'`,
      runAfter,
      lastError,
      nowIso(),
      id,
    );
    return changes === 1;
  }

  /**
   * Settles a claimed job. Guarded on `status = 'claimed'`, so a worker that lost its
   * lease cannot overwrite the outcome recorded by whoever took over.
   */
  settle(id: number, status: 'succeeded' | 'failed' | 'unknown', lastError: string | null): boolean {
    const { changes } = execute(
      this.db,
      `UPDATE jobs
          SET status = ?, claimed_by = NULL, lease_until = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed'`,
      status,
      lastError,
      nowIso(),
      id,
    );
    return changes === 1;
  }

  /** Cancels a job that has not run. A settled job keeps its outcome. */
  cancel(id: number): boolean {
    const { changes } = execute(
      this.db,
      `UPDATE jobs SET status = 'cancelled', claimed_by = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
      nowIso(),
      id,
    );
    return changes === 1;
  }

  /** Cancels every pending job for a variant, used when its text is edited. */
  cancelPendingForVariant(variantId: number): number {
    const { changes } = execute(
      this.db,
      `UPDATE jobs SET status = 'cancelled', claimed_by = NULL, lease_until = NULL, updated_at = ?
        WHERE variant_id = ? AND status = 'pending'`,
      nowIso(),
      variantId,
    );
    return changes;
  }

  /** Resolves a parked `unknown` job once a human has checked the target. */
  resolve(id: number, status: 'succeeded' | 'failed', note: string): boolean {
    const { changes } = execute(
      this.db,
      `UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'unknown'`,
      status,
      note,
      nowIso(),
      id,
    );
    return changes === 1;
  }
}
