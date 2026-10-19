import type { Config } from '../config.js';
import { conflict, notFound } from '../http/errors.js';
import type { Variant, VariantRepository } from '../variants/repository.js';
import { SCHEDULABLE_STATUSES } from '../variants/workflow.js';
import type { Job, JobRepository } from './repository.js';
import { idempotencyKey, parseSlot } from './slots.js';

export interface ScheduleOutcome {
  job: Job;
  /** False when this slot was already scheduled, so the route answers 200, not 201. */
  created: boolean;
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
    const adapter = this.config.publishers[variant.platform];

    return this.jobs.create({
      variantId: variant.id,
      slotAt: slot,
      idempotencyKey: idempotencyKey(variant.id, slot),
      adapter,
    });
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
