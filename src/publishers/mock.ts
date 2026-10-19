import type { Db } from '../db/index.js';
import { nowIso, queryOne } from '../db/index.js';
import { published, type PublishRequest, type PublishResult, type SocialPublisher } from './types.js';

/**
 * A mock publisher. It records what it *would* have posted in `mock_posts` and serves
 * a preview at `/mock/posts/:id`, so a campaign can be published end to end with no
 * external account.
 *
 * It dedupes by idempotency key, enforced by `UNIQUE (adapter, idempotency_key)` in
 * the schema rather than by a check in code. Sending the same key twice returns the
 * first stored row, which is what a well-behaved real API does and what makes the
 * mocks safe to retry after an ambiguous failure.
 */
export class MockPublisher implements SocialPublisher {
  readonly dedupesByKey = true;

  constructor(
    readonly name: 'mock_x' | 'mock_linkedin',
    private readonly db: Db,
    private readonly baseUrl: string,
  ) {}

  get target(): string {
    return `${this.name} (stored locally, preview at ${this.baseUrl}/mock/posts/:id)`;
  }

  // `async` only to satisfy the interface: this adapter does no I/O beyond SQLite,
  // which `node:sqlite` performs synchronously.
  async publish(request: PublishRequest): Promise<PublishResult> {
    // ON CONFLICT DO NOTHING plus RETURNING: an insert returns the new row, while a
    // repeat returns nothing at all. One statement tells us which happened.
    const inserted = queryOne<{ id: number }>(
      this.db,
      `INSERT INTO mock_posts (adapter, idempotency_key, platform, text, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (adapter, idempotency_key) DO NOTHING
       RETURNING id`,
      this.name,
      request.idempotencyKey,
      request.platform,
      request.text,
      nowIso(),
    );

    if (inserted) {
      return published(String(inserted.id), this.previewUrl(inserted.id));
    }

    // The key was already stored, so this is a retry of a post that already exists.
    const existing = queryOne<{ id: number }>(
      this.db,
      'SELECT id FROM mock_posts WHERE adapter = ? AND idempotency_key = ?',
      this.name,
      request.idempotencyKey,
    );
    if (!existing) {
      // Would mean the row vanished between the two statements, which cannot happen
      // under SQLite's single writer. Fail loudly rather than invent an id.
      throw new Error(`mock_posts row for key ${request.idempotencyKey} neither inserted nor found`);
    }
    return published(String(existing.id), this.previewUrl(existing.id), true);
  }

  private previewUrl(id: number): string {
    return `${this.baseUrl}/mock/posts/${id}`;
  }
}

export interface MockPost {
  id: number;
  adapter: string;
  idempotencyKey: string;
  platform: string;
  text: string;
  createdAt: string;
}

interface MockPostRow {
  id: number;
  adapter: string;
  idempotency_key: string;
  platform: string;
  text: string;
  created_at: string;
}

/** Reads for the preview page and for tests that check what a mock stored. */
export class MockPostRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): MockPost | undefined {
    const row = queryOne<MockPostRow>(this.db, 'SELECT * FROM mock_posts WHERE id = ?', id);
    return row ? toMockPost(row) : undefined;
  }

  countByKey(adapter: string, idempotencyKey: string): number {
    return (
      queryOne<{ count: number }>(
        this.db,
        'SELECT COUNT(*) AS count FROM mock_posts WHERE adapter = ? AND idempotency_key = ?',
        adapter,
        idempotencyKey,
      )?.count ?? 0
    );
  }
}

function toMockPost(row: MockPostRow): MockPost {
  return {
    id: row.id,
    adapter: row.adapter,
    idempotencyKey: row.idempotency_key,
    platform: row.platform,
    text: row.text,
    createdAt: row.created_at,
  };
}
