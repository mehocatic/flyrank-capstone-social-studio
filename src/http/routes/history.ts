import { Router } from 'express';
import type { PublishAttemptRepository } from '../../jobs/attempts.js';
import type { JobRepository } from '../../jobs/repository.js';
import type { VariantRepository } from '../../variants/repository.js';

/**
 * The publish history: every attempt, with its result and a link to the message.
 *
 * This is the surface a reviewer inspects after a crash, so it has to make the
 * interesting cases obvious: how many attempts a job took, which one succeeded, and
 * whether a job is parked waiting for a human.
 */
export function historyRoutes(
  jobs: JobRepository,
  attempts: PublishAttemptRepository,
  variants: VariantRepository,
): Router {
  const router = Router();

  router.get('/history', (_req, res) => {
    res.json({ jobs: buildHistory(jobs, attempts, variants) });
  });

  router.get('/ui/history', (_req, res) => {
    res.type('html').send(renderHistory(buildHistory(jobs, attempts, variants)));
  });

  return router;
}

interface HistoryEntry {
  jobId: number;
  variantId: number;
  platform: string;
  slotAt: string;
  status: string;
  adapter: string;
  attempts: number;
  lastError: string | null;
  /** The successful attempt, if there is one. At most one can exist, by index. */
  published: { externalId: string | null; externalUrl: string | null; at: string | null } | null;
  timeline: {
    attemptNo: number;
    outcome: string;
    externalId: string | null;
    externalUrl: string | null;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

function buildHistory(
  jobs: JobRepository,
  attempts: PublishAttemptRepository,
  variants: VariantRepository,
): HistoryEntry[] {
  return jobs.listAll().map((job) => {
    const timeline = attempts.listByJob(job.id);
    const success = timeline.find((attempt) => attempt.outcome === 'succeeded');
    const variant = variants.findById(job.variantId);

    return {
      jobId: job.id,
      variantId: job.variantId,
      platform: variant?.platform ?? 'unknown',
      slotAt: job.slotAt,
      status: job.status,
      adapter: job.adapter,
      attempts: job.attempts,
      lastError: job.lastError,
      published: success
        ? { externalId: success.externalId, externalUrl: success.externalUrl, at: success.finishedAt }
        : null,
      timeline: timeline.map((attempt) => ({
        attemptNo: attempt.attemptNo,
        outcome: attempt.outcome,
        externalId: attempt.externalId,
        externalUrl: attempt.externalUrl,
        error: attempt.error,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      })),
    };
  });
}

function renderHistory(entries: HistoryEntry[]): string {
  const rows = entries
    .map((entry) => {
      const successes = entry.timeline.filter((a) => a.outcome === 'succeeded').length;
      const link = entry.published?.externalUrl
        ? `<a href="${escapeHtml(entry.published.externalUrl)}">${escapeHtml(entry.published.externalId ?? 'message')}</a>`
        : escapeHtml(entry.published?.externalId ?? '');

      const timeline = entry.timeline
        .map(
          (a) =>
            `<li><code>#${a.attemptNo}</code> <span class="o o-${a.outcome}">${a.outcome}</span>` +
            `${a.error ? ` <span class="err">${escapeHtml(a.error)}</span>` : ''}</li>`,
        )
        .join('');

      return `<tr>
  <td>${entry.jobId}</td>
  <td>${escapeHtml(entry.platform)}<br><small>variant ${entry.variantId}</small></td>
  <td><small>${escapeHtml(entry.slotAt)}</small></td>
  <td>${escapeHtml(entry.adapter)}</td>
  <td><span class="s s-${entry.status}">${entry.status}</span></td>
  <td><strong>${successes}</strong> of ${entry.timeline.length}</td>
  <td>${link}</td>
  <td><ul class="tl">${timeline}</ul></td>
</tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Publish history</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #8884; padding: .4rem .6rem; text-align: left; vertical-align: top; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  code { font-family: ui-monospace, monospace; }
  .tl { margin: 0; padding-left: 1.1rem; }
  .o-succeeded, .s-succeeded { color: #0a7f3f; font-weight: 600; }
  .o-failed, .s-failed { color: #b3261e; }
  .o-ambiguous, .s-unknown { color: #a15c00; font-weight: 600; }
  .o-in_flight { color: #5b5bd6; }
  .err { opacity: .75; font-size: .85em; }
  small { opacity: .7; }
  .note { max-width: 46rem; opacity: .85; }
</style>
<h1>Publish history</h1>
<p class="note">Every attempt against every job. <strong>Successes</strong> counts the attempts the database
accepted as successful: a partial unique index allows at most one per job, so this column can never exceed 1,
however many retries or restarts happened. A job shown as <span class="s s-unknown">unknown</span> is parked
because a send could not be confirmed and retrying might post twice; a person resolves it with
<code>POST /jobs/:id/resolve</code>.</p>
<table>
  <thead><tr>
    <th>Job</th><th>Target</th><th>Slot</th><th>Adapter</th><th>Status</th>
    <th>Successes</th><th>Message</th><th>Attempts</th>
  </tr></thead>
  <tbody>
${rows || '<tr><td colspan="8">No jobs yet.</td></tr>'}
  </tbody>
</table>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
