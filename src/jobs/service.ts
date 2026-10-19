import type { Config } from '../config.js';
import { conflict, notFound } from '../http/errors.js';
import type { Variant, VariantRepository } from '../variants/repository.js';
import { SCHEDULABLE_STATUSES } from '../variants/workflow.js';
import type { Job, JobRepository } from './repository.js';
import { idempotencyKey, parseSlot } from './slots.js';

/**
 * What a schedule request actually did. Reported explicitly because the interesting
 * cases are the ones that are not "created", and a boolean could not tell them apart.
 */
export type ScheduleAction =
  /** A new job. 201. */
  | 'created'
  /** A cancelled job for this slot was brought back. 200. */
  | 'revived'
  /** A live job for this slot already exists. 200, and the same job comes back. */
  | 'already_scheduled'
  /** This variant and slot has already published. 200, and nothing happens. */
  | 'already_published';

export interface ScheduleOutcome {
  job: Job;
  action: ScheduleAction;
}

export class ScheduleService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly variants: VariantRepository,
    private readonly config: Config,
  ) {}

  /**
   * Schedules an approved variant into a time slot.
   *
   * Two refusals matter here:
   *  - an unapproved variant is refused with 409 and a message (probe 3), because
   *    publishing something nobody approved is the failure this whole workflow exists
   *    to prevent;
   *  - a repeat of the same variant and slot creates no second job, which is where
   *    the idempotency guarantee begins.
   */
  schedule(variant: Variant, at: unknown): ScheduleOutcome {
    if (!SCHEDULABLE_STATUSES.includes(variant.status)) {
      throw conflict(
        'not_approved',
        `Variant ${variant.id} is ${variant.status} and cannot be scheduled. ` +
          `Only an approved variant may be scheduled: approve it first with ` +
          `POST /variants/${variant.id}/approve.`,
        { variantId: variant.id, status: variant.status, required: [...SCHEDULABLE_STATUSES] },
      );
    }

    const slot = parseSlot(at);
    const { job, created } = this.jobs.create({
      variantId: variant.id,
      slotAt: slot,
      idempotencyKey: idempotencyKey(variant.id, slot),
      adapter: this.config.publishers[variant.platform],
    });

    if (created) return { job, action: 'created' };
    return this.handleExistingJob(job, slot);
  }

  /**
   * A job already exists for this variant and slot. What to do depends entirely on
   * why it is not pending, so each status gets a deliberate answer rather than one
   * blanket "here is the existing job".
   */
  private handleExistingJob(job: Job, slot: string): ScheduleOutcome {
    switch (job.status) {
      case 'pending':
      case 'claimed':
        // Already going to happen. Returning the same job is the idempotent answer.
        return { job, action: 'already_scheduled' };

      case 'succeeded':
        // The whole point of the system: this variant and slot has posted, and asking
        // again must not post a second time.
        return { job, action: 'already_published' };

      case 'cancelled': {
        // Someone cancelled it and has now asked again. Without reviving, the dead row
        // would come back with 200 and nothing would ever publish.
        if (!this.jobs.revive(job.id, slot)) {
          throw conflict('concurrent_update', `Job ${job.id} changed while this request ran.`, {
            jobId: job.id,
          });
        }
        return { job: this.requireJob(job.id), action: 'revived' };
      }

      case 'failed':
        // Retrying the identical text would fail the same way. Changing the text is
        // an edit, which resets the variant to draft and needs a fresh approval.
        throw conflict(
          'job_failed',
          `Job ${job.id} for this slot already failed and is not retried automatically: ` +
            `${job.lastError ?? 'no error recorded'}. Edit the variant to change the text, ` +
            `or schedule a different slot.`,
          { jobId: job.id, status: job.status, slot },
        );

      case 'unknown':
        // The uncloseable window. Guessing here is exactly what the design refuses.
        throw conflict(
          'job_unresolved',
          `Job ${job.id} for this slot is parked as unknown: nobody knows whether the message ` +
            `was posted. Check the target, then record the answer with ` +
            `POST /jobs/${job.id}/resolve. Scheduling again before that could post twice.`,
          { jobId: job.id, status: job.status, slot },
        );
    }
  }

  /** Cancels a job that has not run yet. */
  cancel(jobId: number): Job {
    const job = this.requireJob(jobId);
    if (!this.jobs.cancel(jobId)) {
      throw conflict(
        'not_cancellable',
        `Job ${jobId} is ${job.status} and can no longer be cancelled. Only a pending job can be.`,
        { jobId, status: job.status },
      );
    }
    return this.requireJob(jobId);
  }

  /**
   * Records a human's decision about a job parked as `unknown`.
   *
   * This exists because of the one window that cannot be closed: if the process dies
   * between a Discord send and the result being written, nobody can know whether the
   * message exists. The system refuses to guess, and a person who has looked at the
   * channel tells it what happened.
   */
  resolve(jobId: number, outcome: 'succeeded' | 'failed', note: string): Job {
    const job = this.requireJob(jobId);
    if (job.status !== 'unknown') {
      throw conflict(
        'not_resolvable',
        `Job ${jobId} is ${job.status}, not unknown. Only a job parked as unknown needs a human decision.`,
        { jobId, status: job.status },
      );
    }

    if (!this.jobs.resolve(jobId, outcome, `resolved by a human: ${outcome}. ${note}`)) {
      throw conflict('concurrent_update', `Job ${jobId} changed while this request ran.`, { jobId });
    }

    if (outcome === 'succeeded') {
      // The message is live, so the variant is published even though this process
      // never saw the confirmation.
      this.variants.updateStatus(job.variantId, 'approved', 'published');
    }
    return this.requireJob(jobId);
  }

  private requireJob(id: number): Job {
    const job = this.jobs.findById(id);
    if (!job) throw notFound(`No job with id ${id}`);
    return job;
  }
}
