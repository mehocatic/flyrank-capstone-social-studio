/**
 * The whole schema, applied on every boot. Every statement is `IF NOT EXISTS`,
 * so running it twice is harmless and a fresh clone needs no migration step.
 * Timestamps are ISO-8601 UTC strings ('2026-10-19T14:30:00.000Z'), which sort
 * lexicographically, so plain string comparison works for "is this job due?".
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type  TEXT NOT NULL CHECK (source_type IN ('url', 'markdown')),
  source_url   TEXT,
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS variants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform   TEXT NOT NULL CHECK (platform IN ('x', 'linkedin', 'discord')),
  text       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_post ON variants(post_id);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id      INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  slot_at         TEXT NOT NULL,              -- UTC, truncated to the whole minute
  -- The idempotency guarantee starts here: 'variant:{id}:slot:{slot_at}'.
  -- Scheduling the same variant into the same slot twice cannot create a second job.
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed', 'unknown', 'cancelled')),
  adapter         TEXT NOT NULL,              -- resolved when the job is created, so history is auditable
  attempts        INTEGER NOT NULL DEFAULT 0,
  run_after       TEXT NOT NULL,              -- due time; backoff pushes this forward
  claimed_by      TEXT,
  lease_until     TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_variant ON jobs(variant_id);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL,
  adapter     TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('in_flight', 'succeeded', 'failed', 'ambiguous')),
  external_id TEXT,
  external_url TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON publish_attempts(job_id, attempt_no);
-- The safety net behind the worker logic: the database itself refuses a second
-- successful publish for a job, whatever a retry or a restart believes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_success
  ON publish_attempts(job_id) WHERE outcome = 'succeeded';

CREATE TABLE IF NOT EXISTS mock_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  platform        TEXT NOT NULL,
  text            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (adapter, idempotency_key)
);
`;
