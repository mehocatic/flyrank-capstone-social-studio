import type { Db } from '../db/index.js';
import { execute, nowIso, queryAll, queryOne } from '../db/index.js';
import { redact } from '../redact.js';

export type AttemptOutcome = 'in_flight' | 'succeeded' | 'failed' | 'ambiguous';

export interface PublishAttempt {
  id: number;
  jobId: number;
  attemptNo: number;
  adapter: string;
  outcome: AttemptOutcome;
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface AttemptRow {
  id: number;
  job_id: number;
  attempt_no: number;
  adapter: string;
  outcome: AttemptOutcome;
  external_id: string | null;
  external_url: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function toAttempt(row: AttemptRow): PublishAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNo: row.attempt_no,
    adapter: row.adapter,
    outcome: row.outcome,
    externalId: row.external_id,
    externalUrl: row.external_url,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The publish history, and the write-ahead record that makes crash recovery possible.
 *
 * An attempt row is written as `in_flight` **before** the adapter is called. If the
 * process dies mid-send, that row is the only evidence that a send may have happened.
 * Without it, recovery could not tell "never sent" from "possibly sent", and would
 * have to either risk a duplicate or abandon the job.
 */
export class PublishAttemptRepository {
  constructor(private readonly db: Db) {}

  /** Call this, and commit it, before sending anything. */
  startAttempt(jobId: number, attemptNo: number, adapter: string): PublishAttempt {
    const row = queryOne<AttemptRow>(
      this.db,
      `INSERT INTO publish_attempts (job_id, attempt_no, adapter, outcome, started_at)
       VALUES (?, ?, ?, 'in_flight', ?)
       RETURNING *`,
      jobId,
      attemptNo,
      adapter,
      nowIso(),
    );
    if (!row) throw new Error('INSERT ... RETURNING returned no row');
    return toAttempt(row);
  }

  /**
   * Records a success. The partial unique index `one succeeded per job` means a
   * second success for the same job is rejected by the database, whatever a retry or
   * a restart believes. This throws rather than returning false, because a second
   * success is a bug worth surfacing, not a condition to handle.
   */
  finishSucceeded(attemptId: number, externalId: string, externalUrl: string): void {
    execute(
      this.db,
      `UPDATE publish_attempts
          SET outcome = 'succeeded', external_id = ?, external_url = ?, finished_at = ?
        WHERE id = ? AND outcome = 'in_flight'`,
      externalId,
      externalUrl || null,
      nowIso(),
      attemptId,
    );
  }

  /** Records a failure or an ambiguous outcome. Error text is redacted on the way in. */
  finish(attemptId: number, outcome: 'failed' | 'ambiguous', error: string): void {
    execute(
      this.db,
      `UPDATE publish_attempts
          SET outcome = ?, error = ?, finished_at = ?
        WHERE id = ? AND outcome = 'in_flight'`,
      outcome,
      redact(error).slice(0, 1_000),
      nowIso(),
      attemptId,
    );
  }

  /**
   * An attempt left `in_flight`: its worker died between starting the send and
   * writing the result. This is the signal recovery reads.
   */
  findInFlight(jobId: number): PublishAttempt | undefined {
    const row = queryOne<AttemptRow>(
      this.db,
      `SELECT * FROM publish_attempts
        WHERE job_id = ? AND outcome = 'in_flight'
        ORDER BY attempt_no DESC LIMIT 1`,
      jobId,
    );
    return row ? toAttempt(row) : undefined;
  }

  hasSucceeded(jobId: number): boolean {
    return (
      (queryOne<{ count: number }>(
        this.db,
        `SELECT COUNT(*) AS count FROM publish_attempts WHERE job_id = ? AND outcome = 'succeeded'`,
        jobId,
      )?.count ?? 0) > 0
    );
  }

  listByJob(jobId: number): PublishAttempt[] {
    return queryAll<AttemptRow>(
      this.db,
      'SELECT * FROM publish_attempts WHERE job_id = ? ORDER BY attempt_no, id',
      jobId,
    ).map(toAttempt);
  }

  listAll(limit = 200): PublishAttempt[] {
    return queryAll<AttemptRow>(
      this.db,
      'SELECT * FROM publish_attempts ORDER BY id DESC LIMIT ?',
      limit,
    ).map(toAttempt);
  }

  countByOutcome(jobId: number, outcome: AttemptOutcome): number {
    return (
      queryOne<{ count: number }>(
        this.db,
        'SELECT COUNT(*) AS count FROM publish_attempts WHERE job_id = ? AND outcome = ?',
        jobId,
        outcome,
      )?.count ?? 0
    );
  }
}
