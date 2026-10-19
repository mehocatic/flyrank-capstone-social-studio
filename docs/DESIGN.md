# Social Media Studio: Design

## Problem
Turn one blog post into a small social campaign: one text variant per platform, each checked against that
platform's rules. A person approves each variant, and a scheduler publishes every approved variant + slot
**exactly once in effect**. Retries, timeouts and a worker crash must never produce a second post. The app
code does not know which network it publishes to. Configuration picks an adapter per platform.

Stack: **Node.js 24 or newer** (required: the build and all evidence were produced on 24.14), TypeScript,
Express, SQLite via the built-in `node:sqlite` (no native build, no Docker, no Redis). The same SQLite file
is the job store. Variant text comes from templates (no AI).

## Data model (SQLite)
| Table | Key columns | Notes |
|---|---|---|
| `posts` | id, source_type (`url`/`markdown`), source_url, title, body_md, tags, created_at | Single source of truth. URL is fetched **once** at ingest; generation reads only this row. |
| `variants` | id, post_id, platform (`x`/`linkedin`/`discord`), text, status, shaping_notes, created_at, updated_at | status: `draft` → `approved` / `rejected` → `published`. A row exists only if it passed its profile. `shaping_notes` is a JSON list of what generation changed (see below). |
| `jobs` | id, variant_id, slot_at (UTC, whole minute), **idempotency_key UNIQUE**, status, attempts, run_after, claimed_by, lease_until, last_error | key = `variant:{id}:slot:{slot_at}`. status: `pending` / `claimed` / `succeeded` / `failed` / `unknown` / `cancelled`. |
| `publish_attempts` | id, job_id, attempt_no, adapter, outcome, external_id, external_url, error, started_at, finished_at | outcome: `in_flight` / `succeeded` / `failed` / `ambiguous`. **Partial unique index: one `succeeded` per job.** This is the publish history. |
| `mock_posts` | id, adapter, idempotency_key, text, created_at; UNIQUE(adapter, idempotency_key) | What a mock "would have posted". Has a preview page. |

Status rules: editing a variant re-validates it and sets it back to `draft` (pending jobs → `cancelled`).
A `published` variant cannot be edited. A variant can be scheduled only when it is `approved` or `published`.

## Publish path (the idempotency guarantee)
1. **Schedule**: `INSERT` job with the idempotency key. On a duplicate key, the API returns the existing job (200) and creates no new row.
2. **Claim**: one atomic `UPDATE jobs SET status='claimed', lease_until=now+60s … WHERE id=(due pending job) RETURNING *`.
   SQLite has a single writer, so two workers can never claim the same job.
3. **Write-ahead**: insert a `publish_attempts` row with `in_flight` **before** calling the adapter.
4. **Send** via `SocialPublisher.publish()` (HTTP timeout 10 s, shorter than the lease).
5. **Record**: one transaction marks attempt `succeeded` (with message id + link), job `succeeded` and variant `published`.

Errors are classified by the adapter. `retryable` means "definitely not posted" (429, connection refused):
the job goes back to `pending` with backoff, at most 5 attempts. `permanent` (4xx) sets `failed`. `ambiguous`
(timeout after sending, 5xx, connection reset) sets **`unknown`, never auto-retried**.
**Recovery** (worker start + every tick): a `claimed` job with an expired lease and no `in_flight` attempt crashed
before sending, so it goes back to `pending`. With an `in_flight` attempt, the job is retried only if the adapter
dedupes by key (mocks do, through their UNIQUE key). Otherwise (Discord) it is parked as `unknown` for a human
(`POST /jobs/:id/resolve`).
### The lease must outlast the publish timeout, with a margin
A claim carries a lease. If that lease expires while worker A is **still inside `fetch`**, worker B treats
the job as abandoned, claims it and sends the message a second time. Guarding the database write does not
help: by then the duplicate is already posted. `settle` protects the *record*, not the *send*.

So the lease has to cover everything that can happen between the claim and the result being committed:

| # | Step | Bound |
|---|---|---|
| 1 | claim committed, request leaves (event loop, JSON encode, TLS) | small, not zero |
| 2 | the request itself | `PUBLISH_TIMEOUT_MS` |
| 3 | handling the abort, then committing the outcome (one fsynced SQLite write) | small, not zero |
| 4 | clock and scheduling jitter between two processes | small, not zero |

Steps 1, 3 and 4 are each tiny, and any of them can stretch without warning: a GC pause, a busy disk, a
laptop suspending mid-send. Two different thresholds guard this, and the distinction matters:

- **At boot, `LEASE_SAFETY_MARGIN_MS` (20 s):** `WORKER_LEASE_MS >= PUBLISH_TIMEOUT_MS + 20_000`, or the
  process refuses to start and says why. This is the design-level promise that a freshly claimed job has
  generous headroom. The defaults (10 s timeout, 60 s lease) leave 50 s.
- **Before each send, `LEASE_COMMIT_ALLOWANCE_MS` (2 s):** the worker checks it still holds at least
  `PUBLISH_TIMEOUT_MS + 2_000` of lease. If not, which is what a long suspend looks like, it releases the
  job **without sending**. Nothing was sent, so releasing is always safe.

The runtime threshold is deliberately much smaller than the boot margin, because it only has to cover step 3:
aborting the request and committing one row. Using the same constant for both was a real bug in this code. A
lease of exactly `timeout + margin` is already a few milliseconds short the instant it is claimed, so every
job was released unsent and retried until a millisecond boundary happened to line up. See BUILDLOG.

The margin is a mitigation, not a proof. A pause longer than the whole lease can still cause a double send,
and no lease length removes that: it is the same impossibility as the Discord crash window. The pre-send
check is what makes it survivable in practice, because a process resuming from a long pause declines to send
rather than sending late.

### Re-scheduling a slot that already has a job
The idempotency key is `variant:{id}:slot:{slot}` and uniqueness lives in the index, so a second schedule
request for the same minute can never create a second row. What should happen then depends entirely on why
the existing job is not pending, so each status gets a deliberate answer rather than "here is the row":

| Existing job | Answer | Why |
|---|---|---|
| `pending`, `claimed` | **200**, `already_scheduled`, same job | It is already going to happen. Returning the same job is the idempotent answer. |
| `succeeded` | **200**, `already_published`, nothing happens | This is the guarantee itself: the same variant and slot must not post twice. |
| `cancelled` | **200**, `revived`, back to `pending` with `attempts` reset | Someone cancelled it and has now asked again. Returning the dead row would mean 200 and nothing ever publishing, a silent failure. Reviving needs a deliberate API call each time, so no crash loop can drive it. |
| `failed` | **409** `job_failed` | Retrying identical text fails identically. Changing the text is an edit, which resets the variant to `draft` and needs a fresh approval. |
| `unknown` | **409** `job_unresolved` | Nobody knows whether the message was posted. Scheduling again before a human resolves it could post twice, which is exactly what this system refuses to guess at. |

**Proving the crash window.** Step 4 (send) and step 5 (record) cannot be made atomic, so the gap between
them is the one place a crash can lose information. To prove the behaviour there twice over:
- **An injectable seam, for an automated test.** The worker accepts an optional `afterSend` hook, unused in
  production. A test makes it throw, which simulates the process dying *precisely* between the send
  returning and the result being committed. No process is killed, so the test is deterministic and a
  reviewer can rerun it.
- **A real kill, for a transcript.** `npm run worker` is stopped by hand mid-batch and restarted, and the
  history is then inspected. This proves it on a real run, where the test proves it repeatably.

**Remaining window (honest):** Discord webhooks have no idempotency key. If the process dies after Discord
accepts the POST but before step 5 commits, we cannot know whether the message exists. We choose
**at-most-once** (park it) over at-least-once (risk a duplicate). `?wait=true` returns the message id
immediately, which keeps the window to about one network round trip plus one local commit.

## SocialPublisher interface
```ts
type PublishResult =
  | { ok: true; externalId: string; url: string; deduplicated: boolean }
  | { ok: false; kind: 'retryable' | 'permanent' | 'ambiguous'; error: string };

interface SocialPublisher {
  readonly name: string;           // 'discord' | 'mock_x' | 'mock_linkedin'
  readonly dedupesByKey: boolean;  // true if publishing the same key twice is safe
  readonly target: string;         // for the history view, and never a secret
  publish(req: { idempotencyKey: string; platform: Platform; text: string }): Promise<PublishResult>;
}
```
`dedupesByKey` is the flag the whole crash-safety argument turns on. After an **ambiguous** failure the
worker may retry only an adapter that returns `true`, because the target will recognise the key and not
post twice. An adapter returning `false` (the Discord webhook) is parked as `unknown` instead.
`deduplicated: true` means the target recognised the key and handed back the existing message, which the
history shows so a reviewer can tell a fresh post from an absorbed retry.

Failures are classified **by the adapter**, because only the adapter knows what its protocol guarantees:
`retryable` (provably not posted), `permanent` (provably rejected), `ambiguous` (unknown, and the dangerous
one). Misclassifying `ambiguous` as `retryable` is exactly how duplicates happen.

### Discord failure classification
The asymmetry that drives every line below: a wrong `retryable` posts the message twice, while a wrong
`ambiguous` costs one manual resolution. So **anything that might already have been processed is
`ambiguous`**, and only a provably-undelivered failure is `retryable`.

| What happened | Class | Reasoning |
|---|---|---|
| Timeout (`AbortSignal` fires) | `ambiguous` | The request was already on the wire. Discord may have created the message and only the response was lost. The most likely real-world crash case. |
| Connection reset in flight (`ECONNRESET`, `socket hang up`) | `ambiguous` | Same: the request may have been fully received and processed before the socket died. |
| **5xx** (500, 502, 503, 504) | `ambiguous`, **not** `retryable` | A 5xx is not proof of non-delivery. Discord can accept and process a message, then fail on the way back, for example in a gateway or load balancer. Treating 5xx as retryable is the classic duplicate-post bug. |
| 408 request timeout | `ambiguous` | The server stopped waiting on the request. Usually nothing was created, but "usually" is not a guarantee. |
| **429** rate limited | `retryable` | Discord rejects the request at the rate limiter, before any message is created. This is the one failure class that is provably safe to retry. `retry-after` is recorded. |
| **400** invalid payload | `permanent` | The request was understood and refused. Retrying the same body cannot change the outcome. |
| **404** unknown webhook | `permanent` | The webhook is deleted. It will not come back. |
| 401, 403 | `permanent` | The token is revoked or wrong. Retrying cannot fix a credential. |
| Any other 4xx | `permanent` | A request this webhook will never accept. |
| Connection refused, DNS failure (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) | `retryable` | No server was ever reached, so nothing can have been posted. |
| Anything unrecognised | `ambiguous` | Defaulting to the safe direction. A guess of `retryable` here is how a duplicate happens. |
| **2xx with an unreadable body** | **success**, not a failure | Discord accepted the message, so a retry would post twice. Only the id is lost, and the attempt is recorded as succeeded with id `unknown`. Reporting this as a failure would cause the duplicate it looks like it is preventing. |

Each row is covered by a test in `src/publishers/discord.test.ts`.

### The webhook URL cannot reach the database or a log
The webhook URL is the only real secret in the system, and the realistic leak path is not a careless
`console.log`: it is an **error message**. Node's `fetch` embeds the request URL in thrown errors, often in a
nested `cause`, and such text flows into `publish_attempts.error` and `jobs.last_error`, which the publish
history serves over HTTP. Three measures, defence in depth:
1. `redact()` in `src/redact.ts` strips any webhook URL or bare `/api/webhooks/{id}/{token}` path. It matches
   **structurally**, not by comparing against the configured value, so a URL from a redirect, a nested cause
   or a copy of the config is caught as well.
2. The adapter redacts every failure string and every error body before returning it, so nothing unredacted
   is ever handed upstream to be stored.
3. The two places that print an arbitrary error (the Express error handler and the boot failure) redact
   first, so a future code path that *throws* rather than returns cannot leak either.

No endpoint returns the webhook URL, and `SocialPublisher.target` deliberately describes the destination
without it. Verified by test and by a grep audit, recorded in EVIDENCE.

`createPublisher(name)` in `src/publishers/index.ts` is the **only** place that maps a name to an
implementation. Nothing else in the codebase names a concrete adapter, which is what makes probe 6 a
configuration change rather than a code change.
*Platform* (content rules) and *adapter* (transport) are separate. `.env` maps them: `PUBLISHER_X=mock_x`,
`PUBLISHER_LINKEDIN=mock_linkedin`, `PUBLISHER_DISCORD=discord`. Probe 6 changes one line
(`PUBLISHER_DISCORD=mock_x`) and restarts. The only place that knows adapter names is the registry
`createPublisher(name)`. Every attempt records which adapter it used.

## Constraint profiles (enforced in code, all violations reported)
| Rule id | x | linkedin | discord |
|---|---|---|---|
| `min_length` / `max_length` (Unicode code points) | 1 / 280 | 100 / 3000 | 1 / 2000 |
| `max_hashtags` | 2 | 5 | 0 |
| `max_exclamations` (tone) | 1 | 2 | 3 |
| `no_shouting`: no ALL-CAPS word with ≥ 4 letters (tone) | ✓ | ✓ | n/a |
| `banned_words` (tone: `lol`, `omg`, `!!!` …) | ✓ | ✓ | n/a |
| `no_mass_mentions` (`@everyone`, `@here`) | ✓ | ✓ | ✓ (and `allowed_mentions: {parse: []}`) |

A violation returns **422** `{ error: "constraint_violation", violations: [{ rule: "max_length", platform: "x", limit: 280, actual: 312, message }] }`.
The generator shapes its text to fit (it truncates at a word boundary and takes the top N tags). Its output is
validated anyway, so a broken template can never reach review.

### Shaping is recorded, never silent
Shaping does not only cut length: it rewrites the author's words. It de-shouts ALL-CAPS words, reduces
exclamation marks, drops forbidden slang and mass mentions, and drops links from the source text in favour of
the canonical one. Each variant therefore stores `shaping_notes`, a list of plain-language notes
("normalised 2 all-caps words (ALWAYS, SHIPPED)", "removed 1 banned word (lol)"), returned by
`POST /posts/:id/generate` and by every variant read.

**Why.** A reviewer approves the final text, so no unapproved wording can ever be published, and in that sense
silence would be safe. It would still be wrong. The reviewer is approving words that differ from what the
author wrote, and without the notes they cannot see which differences were ours. A diff against the source is
not enough either: it shows *that* text changed, not *which rule* caused it. The notes make the system's
edits auditable and explain themselves in terms of the profile.

Two rules follow from this:
- **Shaping changes only what a profile actually requires.** `!!!` is left alone on Discord, which permits
  three, and reduced on X, which permits one. Shaping never touches text that would already pass.
- **Shaping never changes meaning.** Nothing is reworded, and no claim is added or removed. Only length,
  capitalisation, punctuation count, listed slang and link placement are touched. A hand-written variant is
  never shaped at all, so its notes are always empty.

## API surface (JSON)
| Method & path | Purpose |
|---|---|
| `POST /posts` `{url}` or `{markdown, title?, tags?}` | Ingest + store → 201 |
| `GET /posts/:id` · `GET /posts/:id/variants` | Read |
| `POST /posts/:id/generate` | One variant per configured platform (`PLATFORMS=x,linkedin,discord`) from the stored post |
| `POST /posts/:id/variants` `{platform, text}` | Manual variant → 201, or 422 naming the rule (probe 2) |
| `PATCH /variants/:id` `{text}` · `POST /variants/:id/approve` · `POST /variants/:id/reject` | Review |
| `POST /variants/:id/schedule` `{at}` | 201 new job, 200 same slot, **409 if not approved** (probe 3) |
| `GET /jobs` · `POST /jobs/:id/publish` · `POST /jobs/:id/cancel` · `POST /jobs/:id/resolve` | Jobs. `publish` runs the same claim path now (phase 4 gate). |
| `GET /history` (JSON) · `GET /ui/history` (HTML table) · `GET /mock/posts/:id` (preview) | Publish history with links |

Processes: `npm start` runs the API and the worker in one process (the single command). `npm run api` and
`npm run worker` run them separately. Ctrl+C stops claiming and finishes the current job. A hard kill relies on lease recovery.

## Non-goal
**No exactly-once delivery to Discord.** Without an idempotency key on the remote side it is impossible.
We guarantee "never twice" and accept a rare `unknown` that a human resolves.
(Also out of scope, per the brief: auth/multi-user, images, analytics, real X/LinkedIn/Instagram.)
