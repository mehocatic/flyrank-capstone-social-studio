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
