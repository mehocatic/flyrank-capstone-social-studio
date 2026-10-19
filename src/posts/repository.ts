import type { Db } from '../db/index.js';
import { nowIso, queryAll, queryOne } from '../db/index.js';

export interface Post {
  id: number;
  sourceType: 'url' | 'markdown';
  sourceUrl: string | null;
  title: string;
  bodyMd: string;
  tags: string[];
  createdAt: string;
}

/** Shape of a `posts` row as SQLite returns it (snake_case, tags still JSON text). */
interface PostRow {
  id: number;
  source_type: 'url' | 'markdown';
  source_url: string | null;
  title: string;
  body_md: string;
  tags: string;
  created_at: string;
}

/** One place that maps a row to the domain object, so the JSON shape is consistent. */
function toPost(row: PostRow): Post {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    title: row.title,
    bodyMd: row.body_md,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
  };
}

export interface NewPost {
  sourceType: 'url' | 'markdown';
  sourceUrl: string | null;
  title: string;
  bodyMd: string;
  tags: string[];
}

export class PostRepository {
  constructor(private readonly db: Db) {}

  insert(post: NewPost): Post {
    // RETURNING * hands back the stored row (id and created_at included) in one
    // statement, instead of an insert followed by a select.
    const row = queryOne<PostRow>(
      this.db,
      `INSERT INTO posts (source_type, source_url, title, body_md, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
      post.sourceType,
      post.sourceUrl,
      post.title,
      post.bodyMd,
      JSON.stringify(post.tags),
      nowIso(),
    );
    if (!row) throw new Error('INSERT ... RETURNING returned no row');
    return toPost(row);
  }

  findById(id: number): Post | undefined {
    const row = queryOne<PostRow>(this.db, 'SELECT * FROM posts WHERE id = ?', id);
    return row ? toPost(row) : undefined;
  }

  list(limit = 50): Post[] {
    return queryAll<PostRow>(this.db, 'SELECT * FROM posts ORDER BY id DESC LIMIT ?', limit).map(
      toPost,
    );
  }
}
