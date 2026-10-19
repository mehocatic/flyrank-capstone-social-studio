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

/** One thing the generator changed, in words a reviewer can read. */
export interface ShapingNote {
  kind:
    | 'normalised_shouting'
    | 'reduced_exclamations'
    | 'removed_banned_words'
    | 'removed_mass_mentions'
    | 'dropped_source_links'
    | 'truncated'
    | 'selected_tags';
  message: string;
}

export interface GeneratedVariant {
  text: string;
  /** What shaping changed. Empty means the source text was used as it stood. */
  notes: ShapingNote[];
}

export function generateVariant(post: Post, platform: Platform): GeneratedVariant {
  const profile = profileFor(platform);
  const log = new ShapingLog();

  const title = shapeTone(post.title, profile, log);
  const sentences = summarySentences(post, title, profile, log);
  const link = profile.maxLinks >= 1 && post.sourceUrl ? post.sourceUrl : '';
  const tags = post.tags.slice(0, profile.maxHashtags);
  const hashtags = tags.map((tag) => `#${tag}`).join(' ');

  // Only worth reporting when a choice was made between tags. A profile that allows
  // no hashtags at all (Discord) is the platform's nature, not something shaping did,
  // and `GET /platforms` already states it.
  if (tags.length > 0 && post.tags.length > tags.length) {
    log.selectedTags(tags.length, post.tags.length);
  }

  const text = ((): string => {
    switch (platform) {
      case 'x': {
        // One hook line: the title, plus the first sentence only if it still fits.
        const hook = sentences[0] ? `${title}: ${lowerFirst(sentences[0])}` : title;
        return assemble([hook], [link, hashtags], profile.maxLength, log);
      }
      case 'linkedin': {
        // Longer form: title as a lead line, then the summary as a paragraph.
        return assemble([title, sentences.slice(0, 4).join(' ')], [link, hashtags], profile.maxLength, log);
      }
      case 'discord': {
        // Bold title is Discord's own formatting. No hashtags: the profile allows none.
        return assemble([`**${title}**`, sentences.slice(0, 3).join(' ')], [link], profile.maxLength, log);
      }
    }
  })();

  return { text, notes: log.notes() };
}

/** Convenience for tests and callers that only need the text. */
export function generateVariantText(post: Post, platform: Platform): string {
  return generateVariant(post, platform).text;
}

/**
 * Collects what shaping changed, then turns it into one note per kind.
 * Counting happens across the whole variant (title and body), so a reviewer sees
 * "normalised 2 all-caps words" rather than one note per sentence.
 */
class ShapingLog {
  private readonly shouted = new Set<string>();
  private readonly banned = new Set<string>();
  private readonly massMentions = new Set<string>();
  private exclamationsReduced = 0;
  private droppedLinks = 0;
  private truncatedTo: number | undefined;
  private tagsSelected: { used: number; available: number } | undefined;

  shouting(word: string): void {
    this.shouted.add(word);
  }
  bannedWord(word: string): void {
    this.banned.add(word);
  }
  massMention(mention: string): void {
    this.massMentions.add(mention);
  }
  exclamations(count: number): void {
    this.exclamationsReduced += count;
  }
  sourceLinks(count: number): void {
    this.droppedLinks += count;
  }
  truncated(limit: number): void {
    this.truncatedTo = limit;
  }
  selectedTags(used: number, available: number): void {
    this.tagsSelected = { used, available };
  }

  notes(): ShapingNote[] {
    const notes: ShapingNote[] = [];
    const list = (values: Set<string>) => [...values].join(', ');

    if (this.shouted.size > 0) {
      notes.push({
        kind: 'normalised_shouting',
        message: `normalised ${plural(this.shouted.size, 'all-caps word')} (${list(this.shouted)})`,
      });
    }
    if (this.exclamationsReduced > 0) {
      notes.push({
        kind: 'reduced_exclamations',
        message: `removed ${plural(this.exclamationsReduced, 'exclamation mark')} to fit the tone limit`,
      });
    }
    if (this.banned.size > 0) {
      notes.push({
        kind: 'removed_banned_words',
        message: `removed ${plural(this.banned.size, 'banned word')} (${list(this.banned)})`,
      });
    }
    if (this.massMentions.size > 0) {
      notes.push({
        kind: 'removed_mass_mentions',
        message: `removed mass mention ${list(this.massMentions)}`,
      });
    }
    if (this.droppedLinks > 0) {
      notes.push({
        kind: 'dropped_source_links',
        message: `dropped ${plural(this.droppedLinks, 'link')} from the source text, keeping the canonical link`,
      });
    }
    if (this.truncatedTo !== undefined) {
      notes.push({
        kind: 'truncated',
        message: `truncated the body to fit ${this.truncatedTo} characters`,
      });
    }
    if (this.tagsSelected) {
      notes.push({
        kind: 'selected_tags',
        message: `used ${this.tagsSelected.used} of ${this.tagsSelected.available} tags as hashtags`,
      });
    }
    return notes;
  }
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * Sentences from the stored body, with URLs removed: the template adds its own
 * canonical link, so keeping source links would push past `max_links`.
 */
function summarySentences(
  post: Post,
  title: string,
  profile: ConstraintProfile,
  log: ShapingLog,
): string[] {
  const withoutHeading = toPlainText(dropLeadingHeading(post.bodyMd));
  const sourceLinks = withoutHeading.match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  if (sourceLinks.length > 0) log.sourceLinks(sourceLinks.length);

  const plain = withoutHeading
    .replace(/https?:\/\/[^\s<>()]+/gi, '')
    .replace(/[ \t]{2,}/g, ' ');

  // Paragraphs first, then sentences inside each. Splitting on '.!?' alone would
  // glue a heading to the sentence after it, because a heading has no full stop,
  // and the title would then be repeated in the body.
  return plain
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+/u))
    .map((sentence) => shapeTone(sentence.replace(/\s+/g, ' ').trim(), profile, log))
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
function assemble(
  bodyParts: string[],
  tailParts: string[],
  maxLength: number,
  log: ShapingLog,
): string {
  const tail = tailParts.filter((part) => part.length > 0).join('\n\n');
  const separator = tail.length > 0 ? 2 : 0; // the '\n\n' joining body and tail
  const budget = maxLength - textLength(tail) - separator;

  const body = bodyParts.filter((part) => part.length > 0).join('\n\n');
  const tooLong = textLength(body) > budget;
  if (tooLong) log.truncated(maxLength);

  return [tooLong ? truncateAtWord(body, budget) : body, tail]
    .filter((part) => part.length > 0)
    .join('\n\n');
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
function shapeTone(text: string, profile: ConstraintProfile, log: ShapingLog): string {
  let out = text;

  // Mass mentions ping a whole server. Never emitted, on any platform.
  out = out.replace(/@(everyone|here)\b/gi, (match) => {
    log.massMention(match);
    return '';
  });

  for (const word of profile.bannedWords) {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'giu'),
      (match) => {
        log.bannedWord(match.toLowerCase());
        return '';
      },
    );
  }

  if (profile.shoutingWordLength > 0) {
    const minLength = profile.shoutingWordLength;
    out = out.replace(/\p{Lu}[\p{Lu}\p{N}]*/gu, (word) => {
      if ([...word].length < minLength || word === word.toLowerCase()) return word;
      log.shouting(word);
      return titleCase(word);
    });
  }

  // Only touched when the profile is actually breached. "!!!" stays as it is on a
  // platform that permits three, so shaping never changes text that would pass.
  const before = (out.match(/!/g) ?? []).length;
  if (before > profile.maxExclamations) {
    out = capExclamations(out.replace(/!{2,}/g, '!'), profile.maxExclamations);
    const after = (out.match(/!/g) ?? []).length;
    if (after < before) log.exclamations(before - after);
  }

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
