import { Router } from 'express';
import { badRequest, notFound } from '../errors.js';
import { asObject, optionalString, parseId } from '../validate.js';
import type { JobRepository } from '../../jobs/repository.js';
import type { ScheduleService } from '../../jobs/service.js';
import type { VariantRepository } from '../../variants/repository.js';

export function jobRoutes(
  service: ScheduleService,
  jobs: JobRepository,
  variants: VariantRepository,
): Router {
  const router = Router();

  // POST /variants/:id/schedule  { at: "2026-10-19T15:00:00Z" | "+2m" }
  router.post('/variants/:id/schedule', (req, res) => {
    const id = parseId(req.params.id, 'variant id');
    const variant = variants.findById(id);
    if (!variant) throw notFound(`No variant with id ${id}`);

    const { job, created } = service.schedule(variant, asObject(req.body).at);

    // 201 for a new job, 200 for one that already existed. The same request twice is
    // not an error: it is the same intent, and it yields the same single job.
    res.status(created ? 201 : 200).json({
      ...job,
      alreadyScheduled: !created,
    });
  });

  router.get('/jobs', (req, res) => {
    const variantId = req.query.variantId;
    if (typeof variantId === 'string') {
      res.json({ jobs: jobs.listByVariant(parseId(variantId, 'variantId')) });
      return;
    }
    res.json({ jobs: jobs.listAll() });
  });

  router.get('/jobs/:id', (req, res) => {
    const id = parseId(req.params.id, 'job id');
    const job = jobs.findById(id);
    if (!job) throw notFound(`No job with id ${id}`);
    res.json(job);
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    res.json(service.cancel(parseId(req.params.id, 'job id')));
  });

  // The human decision for a job parked as `unknown` after an ambiguous send.
  router.post('/jobs/:id/resolve', (req, res) => {
    const id = parseId(req.params.id, 'job id');
    const body = asObject(req.body);
    const outcome = body.outcome;

    if (outcome !== 'succeeded' && outcome !== 'failed') {
      throw badRequest(
        '"outcome" must be "succeeded" (the message is in the channel) or "failed" (it is not)',
      );
    }
    const note = optionalString(body, 'note', 500) ?? 'no note given';
    res.json(service.resolve(id, outcome, note));
  });

  return router;
}
