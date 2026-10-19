import type { Platform } from '../config.js';
import { toPlainText } from '../posts/markdown.js';
import type { Post } from '../posts/repository.js';
import type { ConstraintProfile } from '../platforms/profiles.js';
import { profileFor } from '../platforms/profiles.js';
import { textLength } from '../platforms/validate.js';

/**
 * Builds one variant per platform from the **stored** post, using templates (no AI).
 *
 * Two jobs, kept separate on purpose:
 *  - *shaping* (this file) makes text that should fit the profile: it truncates to
 *    the limit, takes the top N tags, and normalises tone taken from the source.
 *  - *validation* (platforms/validate.ts) is the gate that decides what may be stored.
 *
 * Shaping is a convenience and is allowed to be imperfect. Validation still runs on
 * the result, so a bug in a template can never put a rule-breaking variant in review.
 */

export function generateVariantText(post: Post, platform: Platform): string {
  const profile = profileFor(platform);
  const title = shapeTone(post.title, profile);
  const sentences = summarySentences(post, title, profile);
  const link = profile.maxLinks >= 1 && post.sourceUrl ? post.sourceUrl : '';
  const hashtags = post.tags.slice(0, profile.maxHashtags).map((tag) => `#${tag}`).join(' ');

  switch (platform) {
    case 'x': {
      // One hook line: the title, plus the first sentence only if it still fits.
      const hook = sentences[0] ? `${title}: ${lowerFirst(sentences[0])}` : title;
      return assemble([hook], [link, hashtags], profile.maxLength);
    }
    case 'linkedin': {
      // Longer form: title as a lead line, then the summary as a paragraph.
      const body = sentences.slice(0, 4).join(' ');
      return assemble([title, body], [link, hashtags], profile.maxLength);
    }
    case 'discord': {
      // Bold title is Discord's own formatting. No hashtags: the profile allows none.
      const body = sentences.slice(0, 3).join(' ');
      return assemble([`**${title}**`, body], [link], profile.maxLength);
    }
  }
}

/**
 * Sentences from the stored body, with URLs removed: the template adds its own
 * canonical link, so keeping source links would push past `max_links`.
 */
function summarySentences(post: Post, title: string, profile: ConstraintProfile): string[] {
  const plain = toPlainText(dropLeadingHeading(post.bodyMd))
    .replace(/https?:\/\/[^\s<>()]+/gi, '')
    .replace(/[ \t]{2,}/g, ' ');

  // Paragraphs first, then sentences inside each. Splitting on '.!?' alone would
  // glue a heading to the sentence after it, because a heading has no full stop,
  // and the title would then be repeated in the body.
  return plain
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+/u))
    .map((sentence) => shapeTone(sentence.replace(/\s+/g, ' ').trim(), profile))
    .filter((sentence) => sentence.length > 0)
    .filter((sentence) => normalise(sentence) !== normalise(title));
}

/** Removes the post's own `# Heading` line, which the template already uses as the title. */
function dropLeadingHeading(markdown: string): string {
  const lines = markdown.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return markdown;
  return /^\s{0,3}#{1,6}\s+/.test(lines[first] ?? '')
    ? lines.slice(first + 1).join('\n')
    : markdown;
}

const normalise = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function lowerFirst(sentence: string): string {
  const [first, ...rest] = [...sentence];
  if (!first) return sentence;
  // Only lowercase a plain capital, so an acronym like "SQL ..." is left alone.
  const isAcronymStart = rest[0] !== undefined && rest[0] === rest[0].toUpperCase() && /\p{L}/u.test(rest[0]);
  return isAcronymStart ? sentence : first.toLowerCase() + rest.join('');
}

/**
 * Fits body text into the profile's limit while keeping the tail (link, hashtags)
 * intact, because truncating a URL would make it useless.
 */
function assemble(bodyParts: string[], tailParts: string[], maxLength: number): string {
  const tail = tailParts.filter((part) => part.length > 0).join('\n\n');
  const separator = tail.length > 0 ? 2 : 0; // the '\n\n' joining body and tail
  const budget = maxLength - textLength(tail) - separator;

  const body = bodyParts.filter((part) => part.length > 0).join('\n\n');
  const fitted = textLength(body) > budget ? truncateAtWord(body, budget) : body;

  return [fitted, tail].filter((part) => part.length > 0).join('\n\n');
}

/**
 * Truncates to `limit` code points, preferring a word boundary and marking the cut
 * with an ellipsis. If respecting the word boundary would throw away more than 40%
 * of the budget (one very long word), it cuts mid-word instead of returning a stub.
 */
export function truncateAtWord(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit <= 1) return chars.slice(0, Math.max(limit, 0)).join('');

  const hard = chars.slice(0, limit - 1).join('');
  const atWord = hard.replace(/\s+\S*$/u, '');
  const chosen = textLength(atWord) >= Math.floor(limit * 0.6) ? atWord : hard;
  return `${chosen.trimEnd()}…`;
}

/**
 * Normalises tone carried over from the source text, so generation is not blocked by
 * how the blog author wrote. Only what the profile actually forbids is changed.
 * Meaning is preserved: nothing is reworded, and no claim is added or removed.
 */
function shapeTone(text: string, profile: ConstraintProfile): string {
  let out = text;

  // Mass mentions ping a whole server. Never emitted, on any platform.
  out = out.replace(/@(everyone|here)\b/gi, '');

  if (profile.bannedWords.length > 0) {
    for (const word of profile.bannedWords) {
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'giu'), '');
    }
  }

  if (profile.shoutingWordLength > 0) {
    const minLength = profile.shoutingWordLength;
    out = out.replace(/\p{Lu}[\p{Lu}\p{N}]*/gu, (word) =>
      [...word].length >= minLength && word !== word.toLowerCase() ? titleCase(word) : word,
    );
  }

  out = capExclamations(out.replace(/!{2,}/g, '!'), profile.maxExclamations);

  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

function titleCase(word: string): string {
  const [first, ...rest] = [...word];
  return first === undefined ? word : first + rest.join('').toLowerCase();
}

/** Keeps the first `max` exclamation marks and turns the rest into full stops. */
function capExclamations(text: string, max: number): string {
  let seen = 0;
  return text.replace(/!/g, () => (++seen <= max ? '!' : '.'));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
