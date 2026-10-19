import type { VariantStatus } from './repository.js';

/**
 * The review workflow as one table, rather than if/else spread over the routes.
 * Reading this is how you check the rules; adding a transition is one edit here.
 *
 *   draft     -> approved | rejected
 *   approved  -> rejected  (withdraw an approval before it publishes)
 *   rejected  -> approved  (change your mind)
 *   published -> nothing   (terminal: the message is already live)
 */
export const ALLOWED_TRANSITIONS: Record<VariantStatus, readonly VariantStatus[]> = {
  draft: ['approved', 'rejected'],
  approved: ['rejected'],
  rejected: ['approved'],
  // Terminal on purpose. Un-publishing would be a lie: the post is already out there.
  published: [],
};

/** Statuses whose text may still be edited. Editing sends a variant back to `draft`. */
export const EDITABLE_STATUSES: readonly VariantStatus[] = ['draft', 'approved', 'rejected'];

/** Only an approved variant may be scheduled. This is the rule probe 3 checks. */
export const SCHEDULABLE_STATUSES: readonly VariantStatus[] = ['approved'];

export function canTransition(from: VariantStatus, to: VariantStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The complete refusal message, including the requested target where that helps.
 * Returned whole rather than composed by the caller, so no sentence ends up reading
 * "Variant is already approved, not approved".
 */
export function explainRefusal(from: VariantStatus, to: VariantStatus): string {
  if (from === to) return `Variant is already ${from}`;
  if (from === 'published') {
    return `Variant is published, which is final: a live message cannot be un-published or re-reviewed, so it cannot become ${to}`;
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed.length === 0
    ? `Variant is ${from} and cannot change status, so it cannot become ${to}`
    : `Variant is ${from} and cannot become ${to}; it can only become: ${allowed.join(' or ')}`;
}
