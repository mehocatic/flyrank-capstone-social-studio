import { Router } from 'express';
import type { Config, Platform } from '../../config.js';
import { badRequest, notFound } from '../errors.js';
import { asObject, optionalString, parseId } from '../validate.js';
import type { Post, PostRepository } from '../../posts/repository.js';
import type { Variant, VariantRepository } from '../../variants/repository.js';
import type { VariantService } from '../../variants/service.js';

export function variantRoutes(
  service: VariantService,
  variants: VariantRepository,
  posts: PostRepository,
  config: Config,
): Router {
  const router = Router();

  /** Shared by every route below: a post id in the path must exist. */
  const requirePost = (raw: string | undefined): Post => {
    const id = parseId(raw, 'post id');
    const post = posts.findById(id);
    if (!post) throw notFound(`No post with id ${id}`);
    return post;
  };

  // POST /posts/:id/generate -> one variant per configured platform
  router.post('/posts/:id/generate', (req, res) => {
    const post = requirePost(req.params.id);
    const result = service.generate(post);
    res.status(201).json({
      postId: post.id,
      created: result.created.map((variant) => service.describe(variant)),
      skipped: result.skipped,
      replacedVariantIds: result.replaced,
    });
  });

  // POST /posts/:id/variants  { platform, text } -> a hand-written variant
  router.post('/posts/:id/variants', (req, res) => {
    const post = requirePost(req.params.id);
    const body = asObject(req.body);

    const platform = requirePlatform(body.platform, config);
    const text = optionalString(body, 'text', 10_000);
    if (!text) throw badRequest('"text" is required and must not be empty');

    const variant = service.createManual(post, platform, text);
    res.status(201).json(service.describe(variant));
  });

  router.get('/posts/:id/variants', (req, res) => {
    const post = requirePost(req.params.id);
    res.json({
      postId: post.id,
      variants: variants.listByPost(post.id).map((variant) => service.describe(variant)),
    });
  });

  /** Shared by the review routes below: a variant id in the path must exist. */
  const requireVariant = (raw: string | undefined): Variant => {
    const id = parseId(raw, 'variant id');
    const variant = variants.findById(id);
    if (!variant) throw notFound(`No variant with id ${id}`);
    return variant;
  };

  router.get('/variants/:id', (req, res) => {
    res.json(service.describe(requireVariant(req.params.id)));
  });

  // The review workflow: approve, reject, edit.
  router.post('/variants/:id/approve', (req, res) => {
    res.json(service.describe(service.setStatus(requireVariant(req.params.id), 'approved')));
  });

  router.post('/variants/:id/reject', (req, res) => {
    res.json(service.describe(service.setStatus(requireVariant(req.params.id), 'rejected')));
  });

  // PATCH, not PUT: this replaces one field of the variant, not the whole resource.
  router.patch('/variants/:id', (req, res) => {
    const variant = requireVariant(req.params.id);
    const text = optionalString(asObject(req.body), 'text', 10_000);
    if (!text) throw badRequest('"text" is required and must not be empty');
    res.json(service.describe(service.edit(variant, text)));
  });

  return router;
}

/**
 * A platform must be both known and switched on in PLATFORMS. Asking for a platform
 * the deployment does not run is a 400, not a silent accept, because nothing would
 * ever publish it.
 */
function requirePlatform(value: unknown, config: Config): Platform {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"platform" is required and must be one of: ${config.platforms.join(', ')}`);
  }
  const platform = value.trim().toLowerCase();
  if (!(config.platforms as string[]).includes(platform)) {
    throw badRequest(
      `"platform" must be one of the configured platforms (${config.platforms.join(', ')}), got "${value}"`,
    );
  }
  return platform as Platform;
}
