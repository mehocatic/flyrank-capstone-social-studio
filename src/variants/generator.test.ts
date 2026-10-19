import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Post } from '../posts/repository.js';
import { PLATFORMS } from '../config.js';
import { validateVariant } from '../platforms/validate.js';
import { generateVariantText, truncateAtWord } from './generator.js';

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 1,
    sourceType: 'markdown',
    sourceUrl: null,
    title: 'Publish exactly once, even when the network lies',
    bodyMd:
      '# Publish exactly once, even when the network lies\n\n' +
      'A retry after a timeout is the oldest way to create a duplicate post. ' +
      'The fix is an idempotency key that the database enforces. ' +
      'Claim the job before you send it, and let a unique index refuse the second success.',
    tags: ['idempotency', 'backend', 'sqlite', 'nodejs', 'distributedsystems', 'retries'],
    createdAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('generated variants satisfy their own profile', () => {
  it('passes validation for every platform', () => {
    for (const platform of PLATFORMS) {
      const text = generateVariantText(post(), platform);
      assert.deepEqual(
        validateVariant(platform, text),
        [],
        `${platform} variant should be valid, got: ${text}`,
      );
    }
  });

  it('produces a different variant per platform', () => {
    const texts = PLATFORMS.map((platform) => generateVariantText(post(), platform));
    assert.equal(new Set(texts).size, PLATFORMS.length, 'variants should differ per platform');
  });

  it('takes only as many hashtags as the profile allows', () => {
    // Six tags are on the post; X allows 2, LinkedIn 5, Discord none.
    assert.equal((generateVariantText(post(), 'x').match(/#\w+/g) ?? []).length, 2);
    assert.equal((generateVariantText(post(), 'linkedin').match(/#\w+/g) ?? []).length, 5);
    assert.equal((generateVariantText(post(), 'discord').match(/#\w+/g) ?? []).length, 0);
  });
});

describe('the title is not repeated in the body', () => {
  it('drops the leading heading, which has no full stop to split on', () => {
    // Regression: splitting on '.!?' alone glued the heading to the next sentence,
    // so every variant started with the title twice.
    for (const platform of PLATFORMS) {
      const text = generateVariantText(post(), platform);
      const occurrences = text.split('Publish exactly once, even when the network lies').length - 1;
      assert.equal(occurrences, 1, `${platform} repeated the title: ${text}`);
    }
  });
});

describe('tone is normalised from the source text', () => {
  const shouty = post({
    bodyMd: '# Heading\n\nALWAYS assume the worker can die!!! lol. That is the whole point.',
  });

  it('de-shouts, caps exclamations and drops banned slang for X', () => {
    const text = generateVariantText(shouty, 'x');
    assert.ok(!/ALWAYS/.test(text), `should not shout: ${text}`);
    assert.ok(!/\blol\b/i.test(text), `should not contain slang: ${text}`);
    assert.ok((text.match(/!/g) ?? []).length <= 1, `too many exclamations: ${text}`);
    assert.deepEqual(validateVariant('x', text), []);
  });

  it('leaves tone alone for Discord, whose profile permits it', () => {
    const text = generateVariantText(shouty, 'discord');
    assert.ok(/ALWAYS/.test(text), `Discord may shout: ${text}`);
    assert.deepEqual(validateVariant('discord', text), []);
  });
});

describe('long posts are truncated to fit', () => {
  const long = post({
    bodyMd: `# Durable publishing\n\n${'The worker claims the job before it sends anything. '.repeat(80)}`,
  });

  it('never exceeds the limit on any platform', () => {
    for (const platform of PLATFORMS) {
      const text = generateVariantText(long, platform);
      assert.deepEqual(validateVariant(platform, text), [], `${platform}: ${text.length} chars`);
    }
  });

  it('keeps the hashtags intact rather than truncating them away', () => {
    // The tail is reserved first, so a cut never mangles a link or a hashtag.
    const text = generateVariantText(long, 'linkedin');
    assert.ok(text.trimEnd().endsWith('#distributedsystems'), text.slice(-80));
  });

  it('keeps a URL whole', () => {
    const withUrl = post({
      sourceType: 'url',
      sourceUrl: 'https://example.com/blog/durable-publishing',
      bodyMd: `# Durable publishing\n\n${'The worker claims the job before sending. '.repeat(80)}`,
    });
    const text = generateVariantText(withUrl, 'x');
    assert.ok(text.includes('https://example.com/blog/durable-publishing'), text);
    assert.deepEqual(validateVariant('x', text), []);
  });
});

describe('truncateAtWord', () => {
  it('returns short text unchanged', () => {
    assert.equal(truncateAtWord('hello', 10), 'hello');
  });

  it('cuts at a word boundary and marks the cut', () => {
    assert.equal(truncateAtWord('one two three four', 12), 'one two…');
  });

  it('cuts mid-word rather than returning a stub, for one very long word', () => {
    // At the word boundary this would return almost nothing, so a hard cut is better.
    const result = truncateAtWord('aaaaaaaaaaaaaaaaaaaa bb', 10);
    assert.equal([...result].length, 10);
    assert.ok(result.endsWith('…'));
  });

  it('counts the limit in code points, so emoji are not half-cut', () => {
    assert.equal([...truncateAtWord('😀😀😀😀😀😀', 4)].length, 4);
  });
});
