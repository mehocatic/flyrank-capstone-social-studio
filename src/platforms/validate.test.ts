import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../http/errors.js';
import { PROFILES } from './profiles.js';
import { assertValidVariant, findHashtags, textLength, validateVariant } from './validate.js';

/** Helper: the rule ids a text breaks, which is what the API error reports. */
const rules = (platform: 'x' | 'linkedin' | 'discord', text: string): string[] =>
  validateVariant(platform, text).map((v) => v.rule);

const validX = 'Retries are cheap. Correctness is not. #backend';
const validLinkedIn = `A retry after a timeout must not create a second post. ${'The claim-then-send pattern makes that provable. '.repeat(3)}#backend`;

describe('constraint profiles', () => {
  it('accepts text that fits the profile', () => {
    assert.deepEqual(rules('x', validX), []);
    assert.deepEqual(rules('linkedin', validLinkedIn), []);
    assert.deepEqual(rules('discord', 'Fresh post is up, have a read.'), []);
  });

  it('counts length in code points, so an emoji is one character', () => {
    // "ab😀".length is 4 in JavaScript, because the emoji is two UTF-16 units.
    assert.equal('ab😀'.length, 4);
    assert.equal(textLength('ab😀'), 3);
  });
});

describe('max_length', () => {
  it('blocks an X variant over 280 characters and reports the overshoot', () => {
    const text = 'a'.repeat(281);
    const [violation, ...rest] = validateVariant('x', text);
    assert.equal(rest.length, 0);
    assert.equal(violation?.rule, 'max_length');
    assert.equal(violation?.limit, 280);
    assert.equal(violation?.actual, 281);
    assert.match(violation?.message ?? '', /at most 280 characters, got 281/);
  });

  it('allows exactly the limit', () => {
    assert.deepEqual(rules('x', 'a'.repeat(280)), []);
  });

  it('blocks a LinkedIn variant that is too short to be a real post', () => {
    assert.deepEqual(rules('linkedin', 'Short.'), ['min_length']);
  });
});

describe('max_hashtags', () => {
  it('blocks a third hashtag on X and lists the ones it found', () => {
    const [violation] = validateVariant('x', 'Read this #backend #sqlite #nodejs');
    assert.equal(violation?.rule, 'max_hashtags');
    assert.equal(violation?.actual, 3);
    assert.deepEqual(violation?.found, ['#backend', '#sqlite', '#nodejs']);
  });

  it('allows no hashtags at all on Discord', () => {
    assert.deepEqual(rules('discord', 'New post #backend'), ['max_hashtags']);
  });

  it('does not count a URL fragment as a hashtag', () => {
    // Two independent defences, both asserted here:
    // 1. the '#' follows a word character, which the lookbehind rejects, and
    // 2. the validator strips URLs before counting at all.
    assert.deepEqual(findHashtags('see https://example.com/guide#setup'), []);
    assert.deepEqual(findHashtags('guide#setup'), []);
    assert.deepEqual(rules('discord', 'See https://example.com/guide#setup for setup.'), []);
    // A real hashtag after a URL is still counted, so the URL stripping is not too greedy.
    assert.deepEqual(findHashtags('see https://example.com/guide #setup'), ['#setup']);
    assert.deepEqual(rules('discord', 'See https://example.com/guide #setup'), ['max_hashtags']);
  });

  it('does not count a bare # or #123', () => {
    assert.deepEqual(findHashtags('issue #42 and a lone # here'), []);
  });
});

describe('tone rules', () => {
  it('blocks shouting on X but tolerates it on Discord', () => {
    assert.deepEqual(rules('x', 'This is ALWAYS true'), ['no_shouting']);
    assert.deepEqual(rules('discord', 'This is ALWAYS true'), []);
  });

  it('allows a short acronym', () => {
    assert.deepEqual(rules('x', 'SQL and WAL make this work'), []);
  });

  it('blocks banned slang with word boundaries, not substrings', () => {
    assert.deepEqual(rules('x', 'shipped it lol'), ['banned_words']);
    assert.deepEqual(rules('x', 'a lolly and a lollipop'), []);
  });

  it('blocks too many exclamation marks', () => {
    const [violation] = validateVariant('x', 'Shipped! Live now! Read it!');
    assert.equal(violation?.rule, 'max_exclamations');
    assert.equal(violation?.actual, 3);
  });
});

describe('mentions', () => {
  it('blocks @everyone and @here on every platform', () => {
    for (const platform of ['x', 'linkedin', 'discord'] as const) {
      assert.ok(
        rules(platform, 'Hey @everyone look').includes('no_mass_mentions'),
        `${platform} should block @everyone`,
      );
    }
  });

  it('does not count an email address as a mention', () => {
    assert.deepEqual(rules('discord', 'Mail me at someone@example.com for details.'), []);
  });
});

describe('every rule is reported, not just the first', () => {
  it('lists all broken rules in one result', () => {
    const broken = rules('x', `${'a'.repeat(300)} #one #two #three ALWAYS lol!!!`);
    assert.deepEqual(
      [...broken].sort(),
      ['banned_words', 'max_exclamations', 'max_hashtags', 'max_length', 'no_shouting'],
    );
  });
});

describe('assertValidVariant', () => {
  it('throws a 422 whose details name the broken rules', () => {
    // assert.throws() is typed as returning void, so the error is captured by hand.
    let error: unknown;
    try {
      assertValidVariant('x', 'a'.repeat(300));
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof HttpError, 'expected an HttpError to be thrown');
    assert.equal(error.status, 422);
    assert.equal(error.code, 'constraint_violation');
    assert.match(error.message, /max_length/);
    assert.deepEqual((error.details as { violations: { rule: string }[] }).violations[0]?.rule, 'max_length');
  });

  it('does not throw for valid text', () => {
    assert.doesNotThrow(() => assertValidVariant('x', validX));
  });
});

describe('profiles are data, and the platforms match the design doc', () => {
  it('keeps the documented limits', () => {
    assert.equal(PROFILES.x.maxLength, 280);
    assert.equal(PROFILES.x.maxHashtags, 2);
    assert.equal(PROFILES.linkedin.maxLength, 3000);
    assert.equal(PROFILES.discord.maxLength, 2000);
    assert.equal(PROFILES.discord.maxHashtags, 0);
  });
});
