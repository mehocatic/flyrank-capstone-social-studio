import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// ESM on Node resolves real file paths, so imports point at the compiled .js,
// even though the source is .ts. This is the standard TypeScript/NodeNext style.
import { SCHEMA_SQL } from './schema.js';

export type Db = DatabaseSync;

/** Opens the database file, applies the schema and sets the pragmas the design relies on. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL lets the API read while the worker writes, instead of blocking on each other.
  db.exec('PRAGMA journal_mode = WAL');
  // Durability: survive an OS crash, not just a process crash. The whole
  // "no duplicate after a crash" promise rests on committed rows staying committed.
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  // If the other process holds the write lock, wait instead of failing instantly.
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(SCHEMA_SQL);
  return db;
}

/** ISO-8601 UTC, the single time format stored anywhere in the database. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs `fn` inside a transaction. IMMEDIATE takes the write lock up front, so two
 * writers collide at BEGIN rather than halfway through (SQLite cannot upgrade a
 * reader to a writer, which would otherwise fail the commit).
 * Comparable to a TransactionScope, but there is no ambient context: pass `db` along.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * `node:sqlite` types every row as `Record<string, SQLOutputValue>`, because it
 * cannot know a query's columns. These three helpers are the only place that
 * asserts a row shape, so the unchecked cast lives in one reviewable spot instead
 * of at every call site. The CHECK constraints in the schema are what actually keep
 * the values inside their declared unions.
 */
export function queryOne<T>(db: Db, sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function queryAll<T>(db: Db, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** For INSERT/UPDATE/DELETE without RETURNING. `changes` tells you how many rows matched. */
export function execute(db: Db, sql: string, ...params: SqlParam[]): { changes: number } {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes) };
}

/** The value types SQLite can bind. Dates are stored as ISO strings, so they are `string`. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** True when an error is SQLite rejecting a duplicate (a UNIQUE index doing its job). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    error.message.includes('UNIQUE constraint failed')
  );
}
