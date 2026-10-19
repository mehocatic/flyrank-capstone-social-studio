import { Router } from 'express';
import { notFound } from '../errors.js';
import { parseId } from '../validate.js';
import type { MockPostRepository } from '../../publishers/mock.js';

/**
 * Preview pages for what a mock adapter "posted". The publish history stores links
 * here, so a reviewer can follow a mock publish to something they can actually look at,
 * exactly as they would follow a link to a real message.
 */
export function mockRoutes(mockPosts: MockPostRepository): Router {
  const router = Router();

  router.get('/mock/posts/:id', (req, res) => {
    const id = parseId(req.params.id, 'mock post id');
    const post = mockPosts.findById(id);
    if (!post) throw notFound(`No mock post with id ${id}`);

    // Content negotiation: a browser gets the page, curl and tests get JSON.
    if (req.accepts(['html', 'json']) === 'html') {
      res.type('html').send(renderPreview(post));
      return;
    }
    res.json(post);
  });

  return router;
}

function renderPreview(post: {
  id: number;
  adapter: string;
  platform: string;
  text: string;
  idempotencyKey: string;
  createdAt: string;
}): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${escapeHtml(post.adapter)} preview #${post.id}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
  .card { border: 1px solid currentColor; border-radius: .5rem; padding: 1rem 1.25rem; }
  .meta { opacity: .7; font-size: .85rem; margin-top: 1rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; font: inherit; margin: 0; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
</style>
<h1>Mock post #${post.id}</h1>
<p>This is what <strong>${escapeHtml(post.adapter)}</strong> would have posted to
<strong>${escapeHtml(post.platform)}</strong>. Nothing was sent to a real network.</p>
<div class="card"><pre>${escapeHtml(post.text)}</pre></div>
<p class="meta">
  idempotency key: <code>${escapeHtml(post.idempotencyKey)}</code><br>
  stored at: ${escapeHtml(post.createdAt)}
</p>
</html>`;
}

/** The text is author-supplied, so it is escaped before going into the page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
