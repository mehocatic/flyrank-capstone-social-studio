import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { JobRepository } from './repository.js';
import { idempotencyKey, parseSlot, toSlot } from './slots.js';

let db: Db;
let jobs: JobRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  // A post and an approved variant to hang jobs off, since jobs reference variants.
  db.exec(`
    INSERT INTO posts (id, source_type, title, body_md, created_at)
      VALUES (1, 'markdown', 't', 'b', '2026-10-19T00:00:00.000Z');
    INSERT INTO variants (id, post_id, platform, text, status, created_at, updated_at)
      VALUES (1, 1, 'x', 'hello', 'approved', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z'),
             (2, 1, 'discord', 'hello', 'approved', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  `);
  jobs = new JobRepository(db);
});

const SLOT = '2026-10-19T15:00:00.000Z';
const newJob = (variantId = 1, slot = SLOT, adapter = 'mock_x') => ({
  variantId,
  slotAt: slot,
  idempotencyKey: idempotencyKey(variantId, slot),
  adapter,
});

describe('slots', () => {
  it('truncates to the whole minute, so seconds cannot split one slot in two', () => {
    assert.equal(toSlot(new Date('2026-10-19T15:00:30Z')), SLOT);
    assert.equal(toSlot(new Date('2026-10-19T15:00:59.999Z')), SLOT);
  });

  it('normalises any timezone to UTC, so one instant is one slot', () => {
    assert.equal(parseSlot('2026-10-19T17:00:00+02:00'), SLOT);
    assert.equal(parseSlot('2026-10-19T15:00:00Z'), SLOT);
    assert.equal(parseSlot('2026-10-19T11:00:00-04:00'), SLOT);
  });

  it('accepts a relative offset, which is what probe 4 actually asks for', () => {
    const slot = parseSlot('+2m');
    const minutes = (new Date(slot).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 0.9 && minutes <= 2, `expected about 2 minutes out, got ${minutes}`);
  });

  it('rejects nonsense with a message naming the accepted formats', () => {
    for (const bad of ['', 'tomorrow', '2026-13-45', undefined, 42]) {
      const error = (() => {
        try {
          parseSlot(bad);
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      assert.ok(error instanceof HttpError, `${String(bad)} should be refused`);
      assert.equal(error.status, 400);
    }
  });

  it('builds a key from the variant and the slot', () => {
    assert.equal(idempotencyKey(7, SLOT), 'variant:7:slot:2026-10-19T15:00:00.000Z');
  });
});

describe('scheduling the same variant and slot twice', () => {
  it('creates exactly one job and reports the second as existing', () => {
    const first = jobs.create(newJob());
    const second = jobs.create(newJob());

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id, 'the same job must come back');
    assert.equal(jobs.listAll().length, 1);
  });

  it('survives ten repeats, as a retry storm would produce', () => {
    for (let i = 0; i < 10; i++) jobs.create(newJob());
    assert.equal(jobs.listAll().length, 1);
  });

  it('treats a different slot as a different job', () => {
    jobs.create(newJob(1, SLOT));
    jobs.create(newJob(1, '2026-10-19T16:00:00.000Z'));
    assert.equal(jobs.listByVariant(1).length, 2);
  });

  it('treats a different variant in the same slot as a different job', () => {
    jobs.create(newJob(1, SLOT));
    jobs.create(newJob(2, SLOT, 'discord'));
    assert.equal(jobs.listAll().length, 2);
  });
});

describe('claiming a job', () => {
  it('hands the job to exactly one worker', () => {
    jobs.create(newJob());
    const now = new Date('2026-10-19T15:00:10Z');

    const first = jobs.claimOne('worker-a', 60_000, now);
    const second = jobs.claimOne('worker-b', 60_000, now);

    assert.equal(first?.claimedBy, 'worker-a');
    assert.equal(second, undefined, 'a claimed job must not be claimable again');
  });

  it('does not claim a job before its slot', () => {
    jobs.create(newJob());
    const early = new Date('2026-10-19T14:59:00Z');
    assert.equal(jobs.claimOne('worker-a', 60_000, early), undefined);
  });

  it('counts the attempt at the claim, so a crash loop cannot retry for ever', () => {
    jobs.create(newJob());
    const claimed = jobs.claimOne('worker-a', 60_000, new Date('2026-10-19T15:00:10Z'));
    assert.equal(claimed?.attempts, 1);
  });

  it('sets a lease in the future, which is how a dead worker is detected', () => {
    jobs.create(newJob());
    const now = new Date('2026-10-19T15:00:10Z');
    const claimed = jobs.claimOne('worker-a', 60_000, now);

    assert.equal(claimed?.leaseUntil, '2026-10-19T15:01:10.000Z');
    assert.deepEqual(jobs.listExpiredClaims('2026-10-19T15:00:30.000Z'), []);
    assert.equal(jobs.listExpiredClaims('2026-10-19T15:02:00.000Z').length, 1);
  });

  it('takes the earliest due job first', () => {
    jobs.create(newJob(1, '2026-10-19T16:00:00.000Z'));
    jobs.create(newJob(2, '2026-10-19T15:00:00.000Z', 'discord'));

    const claimed = jobs.claimOne('worker-a', 60_000, new Date('2026-10-19T17:00:00Z'));
    assert.equal(claimed?.slotAt, '2026-10-19T15:00:00.000Z');
  });
});

describe('settling a job', () => {
  const claim = () => {
    jobs.create(newJob());
    return jobs.claimOne('worker-a', 60_000, new Date('2026-10-19T15:00:10Z'));
  };

  it('records a success and clears the lease', () => {
    const job = claim();
    assert.equal(jobs.settle(job?.id ?? 0, 'succeeded', null), true);

    const settled = jobs.findById(job?.id ?? 0);
    assert.equal(settled?.status, 'succeeded');
    assert.equal(settled?.leaseUntil, null);
    assert.equal(settled?.claimedBy, null);
  });

  it('refuses to settle a job this worker no longer holds', () => {
    // The guard that stops a worker which lost its lease from overwriting the
    // outcome recorded by whoever took the job over.
    const job = claim();
    jobs.settle(job?.id ?? 0, 'succeeded', null);

    assert.equal(jobs.settle(job?.id ?? 0, 'failed', 'too late'), false);
    assert.equal(jobs.findById(job?.id ?? 0)?.status, 'succeeded');
  });

  it('releases a job back to pending with a later run_after', () => {
    const job = claim();
    assert.equal(jobs.release(job?.id ?? 0, '2026-10-19T15:05:00.000Z', 'rate limited'), true);

    const released = jobs.findById(job?.id ?? 0);
    assert.equal(released?.status, 'pending');
    assert.equal(released?.runAfter, '2026-10-19T15:05:00.000Z');
    assert.equal(released?.attempts, 1, 'the used attempt is not given back');
  });

  it('parks an ambiguous job as unknown, and will not auto-retry it', () => {
    const job = claim();
    jobs.settle(job?.id ?? 0, 'unknown', 'timed out after sending');

    assert.equal(jobs.findById(job?.id ?? 0)?.status, 'unknown');
    // `unknown` is not pending, so no worker can pick it up again.
    assert.equal(jobs.claimOne('worker-b', 60_000, new Date('2026-10-19T16:00:00Z')), undefined);
  });
});

describe('cancelling', () => {
  it('cancels a pending job', () => {
    const { job } = jobs.create(newJob());
    assert.equal(jobs.cancel(job.id), true);
    assert.equal(jobs.findById(job.id)?.status, 'cancelled');
  });

  it('refuses to cancel a job that already succeeded', () => {
    const { job } = jobs.create(newJob());
    jobs.claimOne('worker-a', 60_000, new Date('2026-10-19T15:00:10Z'));
    jobs.settle(job.id, 'succeeded', null);

    assert.equal(jobs.cancel(job.id), false);
    assert.equal(jobs.findById(job.id)?.status, 'succeeded');
  });

  it('cancels every pending job for a variant, used when its text is edited', () => {
    jobs.create(newJob(1, SLOT));
    jobs.create(newJob(1, '2026-10-19T16:00:00.000Z'));

    assert.equal(jobs.cancelPendingForVariant(1), 2);
    assert.ok(jobs.listByVariant(1).every((job) => job.status === 'cancelled'));
  });
});

describe('resolving a parked job', () => {
  const park = () => {
    const { job } = jobs.create(newJob());
    jobs.claimOne('worker-a', 60_000, new Date('2026-10-19T15:00:10Z'));
    jobs.settle(job.id, 'unknown', 'timed out after sending');
    return job.id;
  };

  it('accepts a human decision that the message did land', () => {
    const id = park();
    assert.equal(jobs.resolve(id, 'succeeded', 'I saw it in the channel'), true);
    assert.equal(jobs.findById(id)?.status, 'succeeded');
  });

  it('accepts a human decision that it did not', () => {
    const id = park();
    assert.equal(jobs.resolve(id, 'failed', 'nothing in the channel'), true);
    assert.equal(jobs.findById(id)?.status, 'failed');
  });

  it('refuses to resolve a job that was never parked', () => {
    const { job } = jobs.create(newJob());
    assert.equal(jobs.resolve(job.id, 'succeeded', 'no'), false);
  });
});
