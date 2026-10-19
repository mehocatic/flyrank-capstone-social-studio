import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VARIANT_STATUSES } from './repository.js';
import {
  ALLOWED_TRANSITIONS,
  EDITABLE_STATUSES,
  SCHEDULABLE_STATUSES,
  canTransition,
  explainRefusal,
} from './workflow.js';

describe('review workflow transitions', () => {
  it('allows a draft to be approved or rejected', () => {
    assert.ok(canTransition('draft', 'approved'));
    assert.ok(canTransition('draft', 'rejected'));
  });

  it('allows an approval to be withdrawn, and a rejection reconsidered', () => {
    assert.ok(canTransition('approved', 'rejected'));
    assert.ok(canTransition('rejected', 'approved'));
  });

  it('treats published as terminal, because the message is already live', () => {
    for (const status of VARIANT_STATUSES) {
      assert.equal(
        canTransition('published', status),
        false,
        `published should not become ${status}`,
      );
    }
    assert.deepEqual(ALLOWED_TRANSITIONS.published, []);
  });

  it('refuses a no-op transition rather than pretending it worked', () => {
    assert.equal(canTransition('approved', 'approved'), false);
    assert.equal(explainRefusal('approved', 'approved'), 'Variant is already approved');
  });

  it('never lets a status jump straight to published', () => {
    // Only the publisher sets `published`, and only after a real send succeeded.
    for (const status of VARIANT_STATUSES) {
      assert.equal(
        canTransition(status, 'published'),
        false,
        `${status} should not be able to declare itself published`,
      );
    }
  });

  it('explains a refusal in terms the caller can act on', () => {
    assert.equal(
      explainRefusal('draft', 'published'),
      'Variant is draft and cannot become published; it can only become: approved or rejected',
    );
    assert.match(explainRefusal('published', 'approved'), /published, which is final/);
  });

  it('reads as one sentence for a no-op, with no "not approved" tacked on', () => {
    // The message is returned whole, so the caller never appends to it.
    assert.equal(explainRefusal('approved', 'approved'), 'Variant is already approved');
    assert.ok(!explainRefusal('approved', 'approved').includes('not approved'));
  });

  it('covers every status in the transition table', () => {
    // A new status added to the union must be given a rule here, or this fails.
    for (const status of VARIANT_STATUSES) {
      assert.ok(Array.isArray(ALLOWED_TRANSITIONS[status]), `${status} has no transition rule`);
    }
  });
});

describe('editing and scheduling rules', () => {
  it('allows editing anything that is not yet live', () => {
    assert.deepEqual([...EDITABLE_STATUSES].sort(), ['approved', 'draft', 'rejected']);
  });

  it('allows scheduling only an approved variant, which is probe 3', () => {
    assert.deepEqual([...SCHEDULABLE_STATUSES], ['approved']);
    for (const status of VARIANT_STATUSES) {
      if (status === 'approved') continue;
      assert.equal(SCHEDULABLE_STATUSES.includes(status), false, `${status} must not be schedulable`);
    }
  });
});
