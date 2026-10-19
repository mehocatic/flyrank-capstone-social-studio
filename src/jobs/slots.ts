import { badRequest } from '../http/errors.js';

/**
 * A slot is a point in time truncated to the whole minute, in UTC.
 *
 * Truncating is what makes the idempotency key stable: `15:00:30Z` and `15:00:45Z`
 * are the same slot, so two requests meaning "the 15:00 post" cannot create two
 * jobs. Expressing it in UTC means `17:00+02:00` and `15:00Z` are also one slot.
 */
export function parseSlot(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('"at" is required: an ISO-8601 time such as "2026-10-19T15:00:00Z" or "+2m"');
  }

  const raw = value.trim();
  const relative = parseRelative(raw);
  const date = relative ?? new Date(raw);

  if (Number.isNaN(date.getTime())) {
    throw badRequest(`"at" is not a valid time: "${raw}". Use ISO-8601, or a relative offset like "+2m"`);
  }
  return toSlot(date);
}

/**
 * Accepts "+2m" / "+90s" / "+1h" as well as an absolute time, because scheduling two
 * minutes out is the single most common thing anyone does with this API (probe 4 asks
 * for exactly that) and hand-writing an ISO timestamp for it invites mistakes.
 */
function parseRelative(raw: string): Date | undefined {
  const match = /^\+(\d+)(s|m|h)$/.exec(raw);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = match[2];
  const seconds = unit === 's' ? amount : unit === 'm' ? amount * 60 : amount * 3600;
  return new Date(Date.now() + seconds * 1000);
}

/** Truncates to the minute and formats as UTC, the single form stored in the database. */
export function toSlot(date: Date): string {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  // 'YYYY-MM-DDTHH:mm:00.000Z' sorts lexicographically, so string comparison answers
  // "is this job due?" without parsing.
  return copy.toISOString();
}

/** The idempotency key: one variant, one slot, one post. Enforced by a UNIQUE index. */
export function idempotencyKey(variantId: number, slot: string): string {
  return `variant:${variantId}:slot:${slot}`;
}
