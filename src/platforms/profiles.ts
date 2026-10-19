import type { Platform } from '../config.js';

/**
 * The constraint profile per platform: data, not code. Adding a rule to a platform
 * is an edit here, and the validator picks it up with no new branches.
 * Values are deliberately close to the real platforms, but they are our policy,
 * not a live API contract.
 */
export interface ConstraintProfile {
  platform: Platform;
  /** Human label used in error messages and the design doc. */
  label: string;
  minLength: number;
  maxLength: number;
  maxHashtags: number;
  maxMentions: number;
  maxLinks: number;
  /** Tone: an excited post is fine, a shouting one is not. */
  maxExclamations: number;
  /** Tone: reject ALL-CAPS words of this length or longer. 0 disables the rule. */
  shoutingWordLength: number;
  bannedWords: readonly string[];
  /** Every platform refuses these: they ping a whole server or audience. */
  forbidMassMentions: boolean;
}

const TONE_BANNED = ['lol', 'omg', 'wtf', 'smh', 'yolo'] as const;

export const PROFILES: Record<Platform, ConstraintProfile> = {
  x: {
    platform: 'x',
    label: 'X (short form)',
    minLength: 1,
    maxLength: 280,
    maxHashtags: 2,
    maxMentions: 3,
    maxLinks: 1,
    maxExclamations: 1,
    shoutingWordLength: 4,
    bannedWords: TONE_BANNED,
    forbidMassMentions: true,
  },
  linkedin: {
    platform: 'linkedin',
    label: 'LinkedIn (long form)',
    // A professional post that is one line reads as spam, hence a real minimum.
    minLength: 100,
    maxLength: 3000,
    maxHashtags: 5,
    maxMentions: 5,
    maxLinks: 2,
    maxExclamations: 2,
    shoutingWordLength: 4,
    bannedWords: TONE_BANNED,
    forbidMassMentions: true,
  },
  discord: {
    platform: 'discord',
    label: 'Discord (message)',
    minLength: 1,
    maxLength: 2000,
    // Hashtags are not a Discord convention; they read as noise, so none are allowed.
    maxHashtags: 0,
    maxMentions: 0,
    maxLinks: 3,
    maxExclamations: 3,
    // A casual channel: shouting and slang are not worth failing a post over.
    shoutingWordLength: 0,
    bannedWords: [],
    forbidMassMentions: true,
  },
};

export function profileFor(platform: Platform): ConstraintProfile {
  return PROFILES[platform];
}
