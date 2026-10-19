import { badRequest } from '../http/errors.js';
import { fetchPost } from './fetchUrl.js';
import { extractTitle, toPlainText } from './markdown.js';
import type { Post, PostRepository } from './repository.js';

const MAX_BODY_CHARS = 200_000;

export interface IngestInput {
  url?: string | undefined;
  markdown?: string | undefined;
  title?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * Ingestion. Either a URL (fetched once, here) or pasted Markdown. Whatever the
 * source, the result is one stored row that generation later reads, and nothing else.
 */
export class PostService {
  constructor(private readonly posts: PostRepository) {}

  async ingest(input: IngestInput): Promise<Post> {
    if (input.url && input.markdown) {
      throw badRequest('Send either "url" or "markdown", not both');
    }
    if (!input.url && !input.markdown) {
      throw badRequest('Send either "url" (a blog post address) or "markdown" (the post text)');
    }

    const source = input.url
      ? await this.fromUrl(input.url)
      : this.fromMarkdown(input.markdown as string);

    // An explicit title always wins, so a bad auto-detected heading can be overridden.
    const title = input.title ?? source.title ?? 'Untitled post';
    const tags = normaliseTags(input.tags ?? []);

    return this.posts.insert({
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      title,
      bodyMd: source.bodyMd,
      tags,
    });
  }

  private async fromUrl(url: string): Promise<SourceContent> {
    const fetched = await fetchPost(url);
    return {
      sourceType: 'url',
      sourceUrl: fetched.finalUrl,
      title: fetched.title,
      bodyMd: fetched.body,
    };
  }

  private fromMarkdown(markdown: string): SourceContent {
    // Guards against an accidental paste of a whole book. The plain-text form is
    // checked, because that is what the generator will actually read.
    if (toPlainText(markdown).length < 20) {
      throw badRequest('"markdown" has too little readable text to generate from (minimum 20 characters)');
    }
    if (markdown.length > MAX_BODY_CHARS) {
      throw badRequest(`"markdown" must be at most ${MAX_BODY_CHARS} characters, got ${markdown.length}`);
    }
    return {
      sourceType: 'markdown',
      sourceUrl: null,
      title: extractTitle(markdown),
      bodyMd: markdown,
    };
  }
}

interface SourceContent {
  sourceType: 'url' | 'markdown';
  sourceUrl: string | null;
  title: string | undefined;
  bodyMd: string;
}

/**
 * Tags are stored bare (no '#') and lowercase, so the generator decides the format
 * per platform and the hashtag count stays countable.
 */
function normaliseTags(tags: string[]): string[] {
  const cleaned = tags
    .map((tag) => tag.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((tag) => tag.length > 0)
    .map((tag) => tag.toLowerCase());
  return [...new Set(cleaned)].slice(0, 10);
}
