import express, { type Express } from 'express';
import type { Config } from '../config.js';
import { queryOne, type Db } from '../db/index.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { platformRoutes } from './routes/platforms.js';
import { postRoutes } from './routes/posts.js';
import { PostRepository } from '../posts/repository.js';
import { PostService } from '../posts/service.js';

export interface AppDeps {
  config: Config;
  db: Db;
}

/**
 * Builds the Express app from explicit dependencies instead of importing a shared
 * singleton, so a test can hand it an in-memory database. This is the hand-rolled
 * version of what .NET's DI container does for you.
 */
export function createApp({ config, db }: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    const count = queryOne<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM posts')?.count ?? 0;
    res.json({
      status: 'ok',
      posts: count,
      platforms: config.platforms,
      // Shown so a reviewer can see which adapter each platform uses without
      // reading .env. That is the proof surface for probe 6 (adapter swap by config).
      publishers: Object.fromEntries(config.platforms.map((p) => [p, config.publishers[p]])),
    });
  });

  app.use(platformRoutes(config));

  const posts = new PostRepository(db);
  app.use(postRoutes(new PostService(posts), posts));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
