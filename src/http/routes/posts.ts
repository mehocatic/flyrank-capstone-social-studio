import { Router } from 'express';
import { notFound } from '../errors.js';
import { asObject, optionalString, optionalStringArray, parseId } from '../validate.js';
import type { PostRepository } from '../../posts/repository.js';
import type { PostService } from '../../posts/service.js';

export function postRoutes(service: PostService, posts: PostRepository): Router {
  const router = Router();

  // POST /posts  { url } | { markdown, title?, tags? }
  router.post('/posts', async (req, res, next) => {
    try {
      const body = asObject(req.body);
      const post = await service.ingest({
        url: optionalString(body, 'url', 2_000),
        markdown: optionalString(body, 'markdown', 200_000),
        title: optionalString(body, 'title', 200),
        tags: optionalStringArray(body, 'tags', 20),
      });
      res.status(201).json(post);
    } catch (error) {
      // Express 5 forwards rejected promises automatically, but passing it on
      // explicitly keeps the behaviour obvious to a reader.
      next(error);
    }
  });

  router.get('/posts', (_req, res) => {
    res.json({ posts: posts.list() });
  });

  router.get('/posts/:id', (req, res) => {
    const id = parseId(req.params.id, 'post id');
    const post = posts.findById(id);
    if (!post) throw notFound(`No post with id ${id}`);
    res.json(post);
  });

  return router;
}
