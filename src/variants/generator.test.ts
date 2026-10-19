import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Post } from '../posts/repository.js';
import { PLATFORMS } from '../config.js';
import { validateVariant } from '../platforms/validate.js';
import { generateVariant, generateVariantText, truncateAtWord } from './generator.js';

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

describe('shaping is recorded, not silent', () => {
  it('reports every change it made to the source text', () => {
    const messy = post({
      bodyMd:
        '# Heading\n\nALWAYS assume the worker can die!!! lol. ' +
        'See https://example.com/old for the SHOUTED details, @everyone.',
    });
    const { notes } = generateVariant(messy, 'x');
    const kinds = notes.map((note) => note.kind);

    assert.ok(kinds.includes('normalised_shouting'), JSON.stringify(notes));
    assert.ok(kinds.includes('reduced_exclamations'), JSON.stringify(notes));
    assert.ok(kinds.includes('removed_banned_words'), JSON.stringify(notes));
    assert.ok(kinds.includes('removed_mass_mentions'), JSON.stringify(notes));
    assert.ok(kinds.includes('dropped_source_links'), JSON.stringify(notes));
    assert.ok(kinds.includes('selected_tags'), JSON.stringify(notes));
  });

  it('counts across the whole variant, naming the words it changed', () => {
    const messy = post({ bodyMd: '# Heading\n\nALWAYS check. SHIPPED means nothing.' });
    const note = generateVariant(messy, 'x').notes.find((n) => n.kind === 'normalised_shouting');
    assert.equal(note?.message, 'normalised 2 all-caps words (ALWAYS, SHIPPED)');
  });

  it('uses the singular for a single change', () => {
    const messy = post({ bodyMd: '# Heading\n\nALWAYS check this before shipping anything.' });
    const note = generateVariant(messy, 'x').notes.find((n) => n.kind === 'normalised_shouting');
    assert.equal(note?.message, 'normalised 1 all-caps word (ALWAYS)');
  });

  it('records truncation with the limit that applied', () => {
    // One sentence longer than X's limit. Many short sentences would not truncate,
    // because the X template only takes the first one.
    const long = post({ bodyMd: `# Heading\n\n${'claim the job then send '.repeat(30)}.` });
    const note = generateVariant(long, 'x').notes.find((n) => n.kind === 'truncated');
    assert.equal(note?.message, 'truncated the body to fit 280 characters');
  });

  it('reports nothing when the source needed no shaping', () => {
    const clean = post({
      bodyMd: '# Heading\n\nA retry after a timeout can create a duplicate post. The fix is a key.',
      tags: ['backend'],
    });
    assert.deepEqual(generateVariant(clean, 'discord').notes, []);
  });

  it('records no tone changes for Discord, whose profile permits them', () => {
    const messy = post({ bodyMd: '# Heading\n\nALWAYS assume the worker can die. lol.' });
    const kinds = generateVariant(messy, 'discord').notes.map((n) => n.kind);
    assert.ok(!kinds.includes('normalised_shouting'), JSON.stringify(kinds));
    assert.ok(!kinds.includes('removed_banned_words'), JSON.stringify(kinds));
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
