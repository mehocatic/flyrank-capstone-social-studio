# Social Media Studio

Turns one blog post into a small social campaign. The system generates one text variant per platform,
checks each against that platform's rules, waits for a human to approve it, and then publishes every
approved variant **exactly once in effect**, even across retries and a worker crash.

The interesting part is not the posting. It is the promise that a retry, a timeout or a hard kill mid-publish
never produces a second post, and being honest about the one window where that cannot be guaranteed.

- **Real publish target:** a Discord webhook on a server you own.
- **Mock targets:** `mock_x` and `mock_linkedin` store what they would have posted and serve a preview page.
- **Variant text:** templates, no AI.
- **Storage and job queue:** one SQLite file. No Docker, no Redis, no background service.

## Requirements

- **Node.js 24 or newer.** Required, not a suggestion: the project uses the built-in `node:sqlite`
  (so `npm install` needs no native build) and `process.loadEnvFile` (so there is no `dotenv` dependency).
  Everything here was built and verified on Node 24.14.0.
- Nothing else. No database server, no container runtime, no paid account.

## Quick start

```bash
npm install
cp .env.example .env     # on Windows: copy .env.example .env
npm start
```

`npm start` builds and runs the API **and** the worker in one process, on <http://localhost:3000>.

Out of the box `.env.example` points every platform at a mock adapter, so it runs with no credentials at
all. To publish to Discord for real, set `DISCORD_WEBHOOK_URL` (see [Publishing to Discord](#publishing-to-discord)).

### Seed sample data

```bash
npm run seed
```

This ingests a sample blog post, generates a variant for every configured platform, approves them, and
prints the ids and the next commands to try. Then:

```bash
curl localhost:3000/posts/1/variants     # see the generated variants
open http://localhost:3000/ui/history    # the publish history (any browser)
```

## Architecture

```
            POST /posts                    POST /posts/:id/generate
          (URL or Markdown)                  (templates, no AI)
                  |                                   |
                  v                                   v
         +------------------+   reads only    +------------------+
         |      posts       |---------------->|    generator     |
         | (source of truth)|                 +------------------+
         +------------------+                          |
                                                       v
                                            +----------------------+
                                            | constraint profiles  |  422 + the broken
                                            |  (validator)         |  rule named
                                            +----------------------+
                                                       | only valid text is stored
                                                       v
      approve / reject / edit          +------------------+
    ------------------------------>    |     variants     |  draft -> approved
       POST /variants/:id/approve      |                  |  -> published
                                       +------------------+
                                                       |  POST /variants/:id/schedule
                                                       |  (approved only, else 409)
                                                       v
                                    +--------------------------------+
                                    |             jobs               |
                                    | idempotency_key UNIQUE         |
                                    | variant:{id}:slot:{minute}     |
                                    +--------------------------------+
                                                       |
                                 +---------------------+
                                 |  worker (same SQLite file)
                                 |
                                 |  1. claim      atomic UPDATE ... RETURNING
                                 |  2. check lease   refuse to send if too little left
                                 |  3. write-ahead   publish_attempts = 'in_flight'
                                 |  4. send          via SocialPublisher
                                 |  5. record        one transaction
                                 v
                    +--------------------------------+
                    |      SocialPublisher           |   <- the adapter seam
                    |  publish(key, platform, text)  |      chosen by configuration
                    +--------------------------------+
                        |            |            |
                        v            v            v
                  DiscordWebhook   MockX      MockLinkedIn
                  (real, no       (dedupes   (dedupes by key)
                   dedupe)         by key)
                        |            |            |
                        +------------+------------+
                                     v
                       +--------------------------------+
                       |        publish_attempts        |
                       | UNIQUE(job_id) WHERE succeeded |  <- at most one success
                       +--------------------------------+
                                     |
                                     v
                            GET /history, /ui/history
```

Everything in one process by default. `npm run api` and `npm run worker` split them, which is what the
crash test needs.

## How "exactly once" is enforced

Four independent mechanisms, each of which would have to fail for a duplicate to appear:

1. **One job per variant and slot.** The key is `variant:{id}:slot:{minute}`, with the slot truncated to the
   whole minute in UTC, and a `UNIQUE` index on it. Scheduling the same variant for the same minute twice
   returns the first job with 200. `15:00:00Z`, `15:00:45Z` and `17:00:00+02:00` are all the same slot.
2. **One worker per job.** A claim is a single `UPDATE ... WHERE status = 'pending' ... RETURNING *`. SQLite
   serialises writers, so of two workers racing for one job exactly one wins. There is no window between
   checking and claiming.
3. **At most one success per job, enforced by the database.** A partial unique index
   (`UNIQUE(job_id) WHERE outcome = 'succeeded'`) means a second successful publish for a job is rejected by
   SQLite, whatever a retry or a restart believes.
4. **Write-ahead attempt rows.** The attempt is recorded as `in_flight` *before* the send. After a crash,
   that row is what distinguishes "never sent" from "possibly sent".

Failures are classified by the adapter, because only the adapter knows what its protocol guarantees:
`retryable` (provably not posted, so safe to retry), `permanent` (provably rejected), and `ambiguous`
(unknown). An `ambiguous` failure is retried **only** when the adapter can dedupe by key.

## The honest limit: the Discord crash window

A Discord webhook has no idempotency key. If the process dies **after** Discord accepts the POST but
**before** the result is committed, nothing can know whether the message exists.

We choose **at-most-once** over at-least-once: such a job is parked as `unknown` and **never retried
automatically**. The history shows it, and a person who has looked at the channel records the answer:

```bash
curl -X POST localhost:3000/jobs/1/resolve \
  -H 'content-type: application/json' \
  -d '{"outcome":"failed","note":"checked the channel, nothing arrived"}'
```

Two things shrink the window rather than claim to close it:

- **`?wait=true`** on the webhook call, so Discord returns the message id immediately. The gap is then about
  one network round trip plus one local commit, instead of lasting until a later reconciliation.
- **The lease outlasts the publish timeout** by `LEASE_SAFETY_MARGIN_MS` (20 s), and a worker refuses to
  start a send that its remaining lease could not cover. Otherwise a lease could expire while a worker was
  still inside `fetch`, and a second worker would send the same message again.

A mock adapter has no such window: it dedupes by key, so an ambiguous failure is simply retried and the
repeat is absorbed. That difference is the whole reason `dedupesByKey` exists on the interface.

## Publishing to Discord

1. In your own Discord server: **Server Settings > Integrations > Webhooks > New Webhook**, pick a channel,
   then **Copy Webhook URL**.
2. Put it in `.env` as `DISCORD_WEBHOOK_URL=...` and set `PUBLISHER_DISCORD=discord`.
3. Optionally set `DISCORD_GUILD_ID` (right-click the server icon > **Copy Server ID**, with Developer Mode
   on) so the history can link straight to the message. Without it the message id is still recorded.

The webhook URL is the only secret here. It is never logged, never returned by any endpoint, and redacted
out of any stored error message, including inside a crash report.

## Reproducing the acceptance probes

Each probe is a copy-paste sequence. Probes 5 and 6 are the ones that need two terminals.

### Probe 1: one post becomes one valid variant per platform

```bash
curl -s -X POST localhost:3000/posts -H 'content-type: application/json' \
  -d '{"markdown":"# Publish exactly once\n\nA retry after a timeout is the oldest way to create a duplicate post. The fix is an idempotency key that the database enforces.","tags":["idempotency","backend"]}'
curl -s -X POST localhost:3000/posts/1/generate
```

One variant per entry in `PLATFORMS`, each inside its own limits, each `draft`. The response includes
`shapingNotes`, which say what the generator changed in the author's words and why.

### Probe 2: a rule-breaking variant is blocked, and the error names the rule

```bash
curl -s -X POST localhost:3000/posts/1/variants -H 'content-type: application/json' \
  -d '{"platform":"x","text":"SHIPPED the thing lol!! #a #b #c #d @everyone"}'
```

**422**, listing every broken rule (`max_hashtags`, `no_mass_mentions`, `max_exclamations`, `no_shouting`,
`banned_words`) with the limit and the actual value. Nothing is stored.

### Probe 3: an unapproved variant cannot be scheduled

```bash
curl -s -X POST localhost:3000/variants/1/schedule \
  -H 'content-type: application/json' -d '{"at":"+2m"}'
```

**409 `not_approved`**, naming the status and the call that fixes it. Then:

```bash
curl -s -X POST localhost:3000/variants/1/approve
curl -s -X POST localhost:3000/variants/1/schedule \
  -H 'content-type: application/json' -d '{"at":"+2m"}'
```

**201**, with the job and its idempotency key. Send that same request again: **200**, the same job, and
`"action":"already_scheduled"`.

### Probe 4: the scheduler publishes to the real target

With `PUBLISHER_DISCORD=discord` and `DISCORD_WEBHOOK_URL` set in `.env`:

```bash
curl -s -X POST localhost:3000/variants/3/approve     # the discord variant
curl -s -X POST localhost:3000/variants/3/schedule \
  -H 'content-type: application/json' -d '{"at":"+2m"}'
```

Within two minutes the message appears in your channel. Then:

```bash
curl -s localhost:3000/history
```

The job is `succeeded` with exactly one `succeeded` attempt, carrying the Discord message id and (with
`DISCORD_GUILD_ID` set) a link straight to it.

### Probe 5: kill the worker mid-publish, restart, no duplicates

**Proved two ways.** The test pins the exact instant; the manual run proves it on a real process.

#### 5a. The automated test, which you can rerun

```bash
npm test
```

Look for the suite **`probe 5: a crash between the send and the result write`**. The worker has an
`afterSend` hook, unused in production, which a test makes throw **between the adapter returning and the
result being committed**. That is the one gap that cannot be made atomic, and it is where a real crash
matters. Four cases:

| Test | What it proves |
|---|---|
| leaves the attempt `in_flight` when the worker dies mid-publish | the crash state is recorded, so recovery can tell what happened |
| a restart results in exactly **one** published message | the whole point of probe 5 |
| re-queues a job whose worker died **before** sending | nothing was sent, so it runs normally |
| parks a job as `unknown` when the adapter cannot dedupe | the Discord case: it must **not** send twice |

No process is killed, so it is deterministic and runs in milliseconds.

#### 5b. The manual run, killing a real process

Run the API and the worker **separately**, so you can kill one and keep querying the other.

**Terminal 1, the API only:**

```bash
npm run build
node --disable-warning=ExperimentalWarning dist/main.js --api
```

**Terminal 2, create an approved job that is due immediately:**

```bash
curl -s -X POST localhost:3000/posts -H 'content-type: application/json' \
  -d '{"markdown":"# Publish exactly once\n\nA retry after a timeout is the oldest way to create a duplicate post. The fix is an idempotency key that the database enforces.","tags":["idempotency"]}'
curl -s -X POST localhost:3000/posts/1/generate
curl -s -X POST localhost:3000/variants/1/approve
# a slot in the past is due right now, so the worker picks it up the moment it starts
curl -s -X POST localhost:3000/variants/1/schedule \
  -H 'content-type: application/json' -d '{"at":"2026-01-01T00:00:00Z"}'
```

**Terminal 3, start the worker and kill it:**

```bash
node --disable-warning=ExperimentalWarning dist/main.js --worker
```

**The command to kill is that `dist/main.js --worker` process**, and it must be a hard kill, not Ctrl+C.
Ctrl+C runs a clean shutdown that finishes the job in flight, which is the opposite of what this probe
tests. Use another terminal:

- macOS or Linux: `pkill -9 -f "main.js --worker"`
- Windows PowerShell: `Get-Process node | Where-Object { $_.CommandLine -like '*--worker*' } | Stop-Process -Force`

To catch it *inside* a send rather than between jobs, point the real adapter at an endpoint that never
answers. `PUBLISH_TIMEOUT_MS=10000` gives a 10 second window to kill it in:

```bash
# a local endpoint that accepts the POST and never responds
node -e "require('node:http').createServer(()=>{}).listen(4555)" &
# then run the worker with:
PLATFORMS=discord PUBLISHER_DISCORD=discord \
DISCORD_WEBHOOK_URL=http://localhost:4555/api/webhooks/1/x \
node --disable-warning=ExperimentalWarning dist/main.js --worker
```

**What to look for, before restarting:**

```bash
curl -s localhost:3000/history
```

The job is `claimed` with an attempt whose outcome is `in_flight`. That attempt row is the evidence a send
may have happened, written before the request went out.

**Now restart the worker** with the same command, and watch two different things happen:

- A job that was still `pending` is published immediately, exactly once. A restart continues the batch.
- The `in_flight` job is **left alone until its lease expires** (`WORKER_LEASE_MS`, 60 s by default). A
  restarted worker must not assume a job is abandoned just because it did not claim it, since another
  worker could still hold it. Once the lease expires, recovery runs.

**What to look for afterwards:**

```bash
curl -s localhost:3000/history        # or open localhost:3000/ui/history
```

| Check | Expected |
|---|---|
| the `successes` column in `/ui/history` | **never more than 1** for any job, whatever happened |
| a job whose adapter is a **mock** | `succeeded`, with exactly one `succeeded` attempt. The retry was absorbed by the key. |
| a job whose adapter is **discord** | `unknown`, with an `ambiguous` attempt saying it was parked. This is the honest outcome, not a failure of the test. |
| a job that never reached the network | ran normally after the restart, one attempt, one success |
| the target itself | exactly one message. If you used the local endpoint above, it logs every POST it receives: there is one, across the kill and the restart. |

Finally, resolve the parked job the way a person would:

```bash
curl -s -X POST localhost:3000/jobs/1/resolve -H 'content-type: application/json' \
  -d '{"outcome":"failed","note":"checked the channel, nothing arrived"}'
```

### Probe 6: swap the adapter in configuration only

Publish a campaign through Discord, then send the same kind of campaign through a mock **without touching
any code**.

1. Check what is wired up now:

   ```bash
   curl -s localhost:3000/health
   ```

   ```json
   {"platforms":["x","linkedin","discord"],"publishers":{"x":"mock_x","linkedin":"mock_linkedin","discord":"discord"}}
   ```

2. Edit **one line** in `.env`:

   ```diff
   - PUBLISHER_DISCORD=discord
   + PUBLISHER_DISCORD=mock_x
   ```

3. Restart (`npm start`) and check again:

   ```bash
   curl -s localhost:3000/health
   ```

   ```json
   {"publishers":{"x":"mock_x","linkedin":"mock_linkedin","discord":"mock_x"}}
   ```

4. Approve and schedule a `discord` variant as in probe 4. It now publishes through the mock: the history
   shows `adapter: "mock_x"` and the message link points at `/mock/posts/:id`, a preview page, instead of
   Discord. Nothing arrives in your channel.

**Why no business logic changed.** `src/publishers/index.ts` is the only file that maps an adapter name to
an implementation. Nothing else in the codebase names a concrete adapter, which you can check:

```bash
grep -rn "MockPublisher\|DiscordWebhookPublisher" src/ --include=*.ts | grep -v "src/publishers/"
# no matches
```

A platform (its content rules) and an adapter (where text is sent) are deliberately separate, which is why
one can be re-pointed without touching the other.

## API

| Method and path | Purpose |
|---|---|
| `POST /posts` | Ingest `{url}` or `{markdown, title?, tags?}`. A URL is fetched **once**, here. |
| `GET /posts` · `GET /posts/:id` | Read stored posts |
| `POST /posts/:id/generate` | One variant per configured platform, from the stored post only |
| `POST /posts/:id/variants` | Hand-written variant `{platform, text}`; 422 if it breaks the profile |
| `GET /posts/:id/variants` · `GET /variants/:id` | Read variants, with length against the limit and the shaping notes |
| `POST /variants/:id/approve` · `POST /variants/:id/reject` | Review. 409 on an illegal transition. |
| `PATCH /variants/:id` | Edit `{text}`. Re-validates, resets to `draft`, cancels pending jobs. |
| `POST /variants/:id/schedule` | `{at}` as ISO-8601 or a relative `+2m`. 409 unless approved. |
| `GET /jobs` · `GET /jobs/:id` | The job store. `?variantId=` filters. |
| `POST /jobs/:id/cancel` | Cancel a job that has not run |
| `POST /jobs/:id/resolve` | Record a human decision on a job parked as `unknown` |
| `GET /history` · `GET /ui/history` | Publish history as JSON, or as a page |
| `GET /platforms` | The active constraint profiles and the adapter for each platform |
| `GET /mock/posts/:id` | What a mock adapter would have posted (page or JSON) |
| `GET /health` | Status, and the live platform-to-adapter mapping |

## Constraint profiles

Enforced in code, in `src/platforms/profiles.ts`. All violations are reported at once, each naming its rule.

| Rule | x | linkedin | discord |
|---|---|---|---|
| length (Unicode code points) | 1 to 280 | 100 to 3000 | 1 to 2000 |
| hashtags | 2 | 5 | none |
| @mentions | 3 | 5 | none |
| links | 1 | 2 | 3 |
| exclamation marks | 1 | 2 | 3 |
| ALL-CAPS words of 4+ characters | refused | refused | allowed |
| slang (`lol`, `omg`, ...) | refused | refused | allowed |
| `@everyone` / `@here` | refused | refused | refused |

The generator shapes text to fit (truncating at a word boundary, taking the top N tags, normalising tone),
and **records what it changed** on the variant, because shaping rewrites the author's words. Its output is
then validated like any other, so a template bug cannot put a rule-breaking variant into review.

## Configuration

Every setting is validated once at startup; a bad value is a boot failure with a readable reason. See
`.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_FILE` | `./data/studio.db` | Posts, variants, jobs and history, all in one file |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | Used to build mock preview links |
| `PLATFORMS` | `x,linkedin,discord` | Which platforms `generate` produces variants for |
| `PUBLISHER_X` / `PUBLISHER_LINKEDIN` / `PUBLISHER_DISCORD` | `mock_x` / `mock_linkedin` / `discord` | Adapter per platform. This is probe 6. |
| `DISCORD_WEBHOOK_URL` | none | Required only when an active platform uses the `discord` adapter |
| `DISCORD_GUILD_ID` | none | Optional, not a secret, only for message links |
| `WORKER_POLL_MS` | `2000` | |
| `WORKER_LEASE_MS` | `60000` | Must be at least `PUBLISH_TIMEOUT_MS + 20000`, or the process refuses to start |
| `PUBLISH_TIMEOUT_MS` | `10000` | |
| `MAX_PUBLISH_ATTEMPTS` | `5` | Counted at the claim, so a crash loop cannot retry for ever |

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Build, then run the API and the worker together |
| `npm run api` | The API only |
| `npm run worker` | The worker only (what probe 5 kills) |
| `npm run seed` | Sample post, generated variants, approved and ready to schedule |
| `npm test` | The whole test suite |
| `npm run build` · `npm run typecheck` | Compile, or type-check without emitting |

## Tests

```bash
npm test
```

138 tests, no network and no `.env` required. The ones that matter most:

| Area | File |
|---|---|
| idempotent publish, crash recovery, the lease | `src/jobs/worker.test.ts` |
| the job store, slots and atomic claiming | `src/jobs/jobs.test.ts` |
| constraint profiles | `src/platforms/validate.test.ts` |
| generation and shaping notes | `src/variants/generator.test.ts` |
| review transitions | `src/variants/workflow.test.ts` |
| Discord failure classification | `src/publishers/discord.test.ts` |
| mock adapters and key dedupe | `src/publishers/mock.test.ts` |
| secrets never reaching a log or the database | `src/redact.test.ts`, `src/process-guards.test.ts` |

## Not in scope

**No exactly-once delivery to Discord**, because a webhook has no idempotency key and it is therefore
impossible. The guarantee is "never twice", with a rare `unknown` that a person resolves.

Also out of scope, per the brief: image generation, analytics, engagement tracking, authentication or
multi-user support, and real X, LinkedIn or Instagram publishing.

## Project documents

- `docs/DESIGN.md` : the one-page design, the data model, and the reasoning behind every classification
- `EVIDENCE.md` : one proof per requirement, each a verbatim transcript
- `BUILDLOG.md` : an honest record of how this was built, including where AI was wrong
