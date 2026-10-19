import type { Platform } from '../config.js';
import type { Db } from '../db/index.js';
import { nowIso, queryAll, queryOne } from '../db/index.js';

/** The review workflow states from the brief. Phase 3 adds the transitions. */
export const VARIANT_STATUSES = ['draft', 'approved', 'rejected', 'published'] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export interface Variant {
  id: number;
  postId: number;
  platform: Platform;
  text: string;
  status: VariantStatus;
  createdAt: string;
  updatedAt: string;
}

interface VariantRow {
  id: number;
  post_id: number;
  platform: Platform;
  text: string;
  status: VariantStatus;
  created_at: string;
  updated_at: string;
}

function toVariant(row: VariantRow): Variant {
  return {
    id: row.id,
    postId: row.post_id,
    platform: row.platform,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class VariantRepository {
  constructor(private readonly db: Db) {}

  insert(postId: number, platform: Platform, text: string): Variant {
    const now = nowIso();
    const row = queryOne<VariantRow>(
      this.db,
      `INSERT INTO variants (post_id, platform, text, status, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?)
       RETURNING *`,
      postId,
      platform,
      text,
      now,
      now,
    );
    if (!row) throw new Error('INSERT ... RETURNING returned no row');
    return toVariant(row);
  }

  findById(id: number): Variant | undefined {
    const row = queryOne<VariantRow>(this.db, 'SELECT * FROM variants WHERE id = ?', id);
    return row ? toVariant(row) : undefined;
  }

  listByPost(postId: number): Variant[] {
    return queryAll<VariantRow>(
      this.db,
      'SELECT * FROM variants WHERE post_id = ? ORDER BY platform, id',
      postId,
    ).map(toVariant);
  }

  /**
   * A variant for this platform that a human has decided on. Regeneration must never
   * touch one of these, so finding any is enough to skip the platform.
   */
  findDecidedByPostAndPlatform(postId: number, platform: Platform): Variant | undefined {
    const row = queryOne<VariantRow>(
      this.db,
      `SELECT * FROM variants
       WHERE post_id = ? AND platform = ? AND status IN ('approved', 'published')
       ORDER BY id DESC LIMIT 1`,
      postId,
      platform,
    );
    return row ? toVariant(row) : undefined;
  }

  /**
   * Every variant regeneration may discard: all of them, not just the newest.
   * An earlier version returned only the latest row, which left older drafts behind
   * and let duplicates pile up for the same platform.
   */
  listReplaceable(postId: number, platform: Platform): Variant[] {
    return queryAll<VariantRow>(
      this.db,
      `SELECT * FROM variants
       WHERE post_id = ? AND platform = ? AND status IN ('draft', 'rejected')
       ORDER BY id`,
      postId,
      platform,
    ).map(toVariant);
  }

  /**
   * Removes a superseded draft so regenerating does not pile up variants.
   * Only ever called for `draft` or `rejected` rows: an approved or published
   * variant is never discarded, because a human decision would be lost.
   */
  deleteById(id: number): void {
    this.db.prepare('DELETE FROM variants WHERE id = ?').run(id);
  }
}
