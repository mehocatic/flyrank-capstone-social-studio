import type { Platform } from '../config.js';
import { unprocessable } from '../http/errors.js';
import { profileFor, type ConstraintProfile } from './profiles.js';

/**
 * Enforces a platform's constraint profile. One violation names one rule, so the
 * API error tells a caller exactly which rule broke and by how much (the brief
 * requires "the error names the broken rule").
 */
export interface Violation {
  rule: string;
  platform: Platform;
  message: string;
  limit?: number;
  actual?: number;
  found?: string[];
}

/** Every rule is checked, not just the first, so one response lists all the problems. */
export function validateVariant(platform: Platform, text: string): Violation[] {
  const profile = profileFor(platform);
  const violations: Violation[] = [];
  const add = (v: Violation) => violations.push(v);

  checkLength(profile, text, add);
  checkHashtags(profile, text, add);
  checkMentions(profile, text, add);
  checkLinks(profile, text, add);
  checkExclamations(profile, text, add);
  checkShouting(profile, text, add);
  checkBannedWords(profile, text, add);

  return violations;
}

/** Throws a 422 if the text breaks any rule. The thrown details are the violations. */
export function assertValidVariant(platform: Platform, text: string): void {
  const violations = validateVariant(platform, text);
  if (violations.length === 0) return;

  const summary = violations.map((v) => v.rule).join(', ');
  throw unprocessable(
    'constraint_violation',
    `Text breaks the ${profileFor(platform).label} profile: ${summary}`,
    { platform, violations },
  );
}

type Add = (violation: Violation) => void;

/**
 * Length in Unicode code points, not UTF-16 units, so an emoji counts as one
 * character. `"ab😀".length` is 4 in JavaScript, which would mis-measure a tweet.
 * (C# has the same trap: string.Length counts UTF-16 chars.)
 */
export function textLength(text: string): number {
  return [...text].length;
}

function checkLength(profile: ConstraintProfile, text: string, add: Add): void {
  const actual = textLength(text.trim());
  if (actual < profile.minLength) {
    add({
      rule: 'min_length',
      platform: profile.platform,
      limit: profile.minLength,
      actual,
      message: `${profile.label} needs at least ${profile.minLength} characters, got ${actual}`,
    });
  }
  if (actual > profile.maxLength) {
    add({
      rule: 'max_length',
      platform: profile.platform,
      limit: profile.maxLength,
      actual,
      message: `${profile.label} allows at most ${profile.maxLength} characters, got ${actual}`,
    });
  }
}

/**
 * A hashtag is '#' plus a letter, then letters, digits or underscores. The '#' must
 * not follow a word character, so a URL fragment like "docs#section" is not a hashtag.
 */
export function findHashtags(text: string): string[] {
  return [...text.matchAll(/(?<![\w#])#(\p{L}[\p{L}\p{N}_]*)/gu)].map((m) => `#${m[1]}`);
}

function checkHashtags(profile: ConstraintProfile, text: string, add: Add): void {
  const found = findHashtags(stripUrls(text));
  if (found.length > profile.maxHashtags) {
    add({
      rule: 'max_hashtags',
      platform: profile.platform,
      limit: profile.maxHashtags,
      actual: found.length,
      found,
      message:
        profile.maxHashtags === 0
          ? `${profile.label} allows no hashtags, found ${found.length}: ${found.join(' ')}`
          : `${profile.label} allows at most ${profile.maxHashtags} hashtags, found ${found.length}: ${found.join(' ')}`,
    });
  }
}

const MASS_MENTIONS = ['@everyone', '@here'] as const;

function checkMentions(profile: ConstraintProfile, text: string, add: Add): void {
  const lower = text.toLowerCase();
  const mass = MASS_MENTIONS.filter((mention) => lower.includes(mention));
  if (profile.forbidMassMentions && mass.length > 0) {
    add({
      rule: 'no_mass_mentions',
      platform: profile.platform,
      found: [...mass],
      message: `${profile.label} forbids mass mentions, found ${mass.join(' and ')}`,
    });
  }

  const found = [...stripUrls(text).matchAll(/(?<![\w@])@(\p{L}[\p{L}\p{N}_.]*)/gu)]
    .map((m) => `@${m[1]}`)
    .filter((mention) => !MASS_MENTIONS.includes(mention.toLowerCase() as (typeof MASS_MENTIONS)[number]));

  if (found.length > profile.maxMentions) {
    add({
      rule: 'max_mentions',
      platform: profile.platform,
      limit: profile.maxMentions,
      actual: found.length,
      found,
      message:
        profile.maxMentions === 0
          ? `${profile.label} allows no @mentions, found ${found.length}: ${found.join(' ')}`
          : `${profile.label} allows at most ${profile.maxMentions} @mentions, found ${found.length}: ${found.join(' ')}`,
    });
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;

/** Removes URLs before counting hashtags and mentions, so a link cannot trip those rules. */
function stripUrls(text: string): string {
  return text.replace(URL_PATTERN, ' ');
}

function checkLinks(profile: ConstraintProfile, text: string, add: Add): void {
  const found = text.match(URL_PATTERN) ?? [];
  if (found.length > profile.maxLinks) {
    add({
      rule: 'max_links',
      platform: profile.platform,
      limit: profile.maxLinks,
      actual: found.length,
      found: [...found],
      message: `${profile.label} allows at most ${profile.maxLinks} links, found ${found.length}`,
    });
  }
}

function checkExclamations(profile: ConstraintProfile, text: string, add: Add): void {
  const actual = (text.match(/!/g) ?? []).length;
  if (actual > profile.maxExclamations) {
    add({
      rule: 'max_exclamations',
      platform: profile.platform,
      limit: profile.maxExclamations,
      actual,
      message: `${profile.label} tone allows at most ${profile.maxExclamations} exclamation marks, found ${actual}`,
    });
  }
}

function checkShouting(profile: ConstraintProfile, text: string, add: Add): void {
  if (profile.shoutingWordLength <= 0) return;

  // Only words that have a lowercase form count, so an acronym stays allowed only
  // if it is shorter than the limit. "SQL" passes at a limit of 4, "ALWAYS" does not.
  const shouted = (text.match(/\p{Lu}[\p{Lu}\p{N}]*/gu) ?? []).filter(
    (word) => [...word].length >= profile.shoutingWordLength && word !== word.toLowerCase(),
  );

  if (shouted.length > 0) {
    add({
      rule: 'no_shouting',
      platform: profile.platform,
      limit: profile.shoutingWordLength,
      found: [...new Set(shouted)],
      message: `${profile.label} tone forbids ALL-CAPS words of ${profile.shoutingWordLength}+ characters, found ${[...new Set(shouted)].join(', ')}`,
    });
  }
}

function checkBannedWords(profile: ConstraintProfile, text: string, add: Add): void {
  if (profile.bannedWords.length === 0) return;

  const lower = text.toLowerCase();
  // Word boundaries, so "lol" does not fire inside "lolly".
  const found = profile.bannedWords.filter((word) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'u').test(lower),
  );

  if (found.length > 0) {
    add({
      rule: 'banned_words',
      platform: profile.platform,
      found: [...found],
      message: `${profile.label} tone forbids these words: ${found.join(', ')}`,
    });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
