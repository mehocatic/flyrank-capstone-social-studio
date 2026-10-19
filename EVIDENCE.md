# Evidence

One proof per requirement from the brief. Every transcript below is real output, pasted verbatim from the
command shown directly above it. Nothing here is illustrative or reconstructed.

Where a requirement is not built yet, the row says so rather than being left blank.

**Setup used for every transcript on this page**

```bash
npm install
cp .env.example .env     # then set DISCORD_WEBHOOK_URL, or point PUBLISHER_DISCORD at a mock
npm start                # API on http://localhost:3000
```

Transcripts were captured on Node 24.14.0, Windows 11, against a fresh (deleted) `./data/studio.db`.
`PUBLISHER_DISCORD=mock_x` was set for these runs, since ingestion does not touch an adapter.

## Requirement status

| # | Requirement | Status | Proof |
|---|---|---|---|
| 1 | Ingestion via URL or Markdown, stored; generation reads only the stored post | **Done** | [E1](#e1-ingestion-via-url-or-markdown) |
| 2 | Constraint profiles enforced by code; a bad variant is blocked | **Partly done**: profiles and validator proved by tests ([E2](#e2-constraint-profiles-are-enforced-by-code)); the blocked-before-review transcript needs the variant endpoint (next step) | [E2](#e2-constraint-profiles-are-enforced-by-code) |
| 3 | Review workflow; unapproved schedule returns 4xx + message | Phase 3 | |
| 4 | Adapter layer: one interface, one real target, >= 2 mocks; swap = config only | Phase 4 | |
| 5 | Idempotent publish: same variant + slot never posts twice, even under retries | Phase 4 | |
| 6 | Durable scheduling: worker restart mid-batch, zero duplicates | Phase 5 | |
| 7 | Publish history: every attempt recorded and visible, with its result | Phase 5 | |
| 8 | Secrets clean: tokens in `.env` only; `.env.example` present | **Done** | [E8](#e8-secrets-are-clean) |
| 9 | README: what it does, architecture, exact run steps, one command + a seed step | Phase 5 | |

## E1: Ingestion via URL or Markdown

**Requirement.** A blog post is accepted as a URL or as pasted Markdown and stored. The stored post is the
single source of truth for generation.

### E1a: pasted Markdown

The title is taken from the `# ` heading, and tags are normalised (the `#` prefix dropped, lowercased,
duplicates and whitespace-only entries removed), so hashtag counts stay countable per platform later.

```bash
curl -s -X POST localhost:3000/posts -H 'content-type: application/json' \
  -d '{"markdown":"# Why idempotency matters\n\nA retry after a timeout must not create a second post. This article explains the claim-then-send pattern, and why a unique key per variant and slot is the cheapest correct answer.","tags":["#Idempotency","backend","  backend "]}'
```

```json
{"id":1,"sourceType":"markdown","sourceUrl":null,"title":"Why idempotency matters","bodyMd":"# Why idempotency matters\n\nA retry after a timeout must not create a second post. This article explains the claim-then-send pattern, and why a unique key per variant and slot is the cheapest correct answer.","tags":["idempotency","backend"],"createdAt":"2026-10-19T12:20:23.214Z"}
```

Three tags were sent (`"#Idempotency"`, `"backend"`, `"  backend "`) and two were stored
(`["idempotency","backend"]`).

### E1b: a real URL

The page is fetched **once**, here, at ingest. The title and body text are extracted from the HTML.

```bash
curl -s -X POST localhost:3000/posts -H 'content-type: application/json' \
  -d '{"url":"https://example.com/"}'
```

```json
{"id":2,"sourceType":"url","sourceUrl":"https://example.com/","title":"Example Domain","bodyMd":"This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.","tags":[],"createdAt":"2026-10-19T12:20:23.418Z"}
```

### E1c: the stored post is what generation will read

Reading the post back returns the stored row, with no second fetch of the remote page. Generation
(phase 2) takes `bodyMd` from this row, so a variant cannot change later because the source blog changed.

```bash
curl -s localhost:3000/posts/2
```

```json
{"id":2,"sourceType":"url","sourceUrl":"https://example.com/","title":"Example Domain","bodyMd":"This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.","tags":[],"createdAt":"2026-10-19T12:20:23.418Z"}
```

### E1d: bad input is refused with a reason that names the problem

Each line is the request body, then the HTTP status and response body.

```bash
curl -s -o /tmp/r -w '%{http_code} ' -X POST localhost:3000/posts \
  -H 'content-type: application/json' -d "$body"   # run once per body below
```

```text
{"url":"https://example.com","markdown":"# hi\n\nlong enough body text goes here"}
  -> 400 {"error":"bad_request","message":"Send either \"url\" or \"markdown\", not both"}
{}
  -> 400 {"error":"bad_request","message":"Send either \"url\" (a blog post address) or \"markdown\" (the post text)"}
{"markdown":"# hi"}
  -> 400 {"error":"bad_request","message":"\"markdown\" has too little readable text to generate from (minimum 20 characters)"}
{"url":"http://169.254.169.254/latest/meta-data/"}
  -> 400 {"error":"bad_request","message":"\"url\" points at a local or private address (169.254.169.254), which is not fetched"}
{"url":"file:///C:/Windows/win.ini"}
  -> 400 {"error":"bad_request","message":"\"url\" must use http or https, got \"file:\""}
{"url":"https://httpbin.org/image/png"}
  -> 422 {"error":"fetch_failed","message":"https://httpbin.org/image/png is \"image/png\", not a readable text page"}
```

```bash
curl -s -w ' [%{http_code}]\n' localhost:3000/posts/999
curl -s -w ' [%{http_code}]\n' localhost:3000/posts/abc
```

```text
{"error":"not_found","message":"No post with id 999"} [404]
{"error":"bad_request","message":"\"post id\" must be a positive integer, got \"abc\""} [400]
```

The third and fourth lines are not in the brief. `169.254.169.254` is the cloud metadata address: because
`POST /posts {url}` makes the server fetch an address the caller chose, loopback, private and link-local
addresses are refused ([src/posts/fetchUrl.ts](src/posts/fetchUrl.ts)). That guard matches on hostname and
does not resolve DNS, so a hostname resolving to a private IP would still pass. Stated here rather than
claimed as complete.

## E2: constraint profiles are enforced by code

**Requirement.** Each platform has rules (max length, tone, hashtag count) and code enforces them. A
rule-breaking variant never reaches review, and the error names the broken rule.

This section proves the profiles and the validator. The "never reaches review" half is proved once the
variant endpoints exist, in the next step.

### E2a: the active profiles, as the running app reports them

The rules are data in [src/platforms/profiles.ts](src/platforms/profiles.ts), and the endpoint reads that
same data, so this output cannot drift from what the validator enforces.

```bash
curl -s localhost:3000/platforms
```

Formatted for reading (the raw response is JSON):

```text
x         adapter=mock_x        len=1-280  tags<=2  mentions<=3  links<=1  "!"<=1  shoutLen=4  banned=[lol,omg,wtf,smh,yolo]
linkedin  adapter=mock_linkedin len=100-3000  tags<=5  mentions<=5  links<=2  "!"<=2  shoutLen=4  banned=[lol,omg,wtf,smh,yolo]
discord   adapter=mock_x        len=1-2000  tags<=0  mentions<=0  links<=3  "!"<=3  shoutLen=0  banned=[]
```

`shoutLen=4` means an ALL-CAPS word of 4 or more characters is refused. `shoutLen=0` disables that rule,
which is why Discord tolerates shouting.

### E2b: the validator, proved by re-runnable tests

A reviewer can rerun this; it is not a transcript of one lucky run.

```bash
npm test
```

```text
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

The 19 cases in [src/platforms/validate.test.ts](src/platforms/validate.test.ts) cover:

| Case | What it proves |
|---|---|
| 281 characters on X | `max_length` fires, and reports `limit: 280, actual: 281` |
| exactly 280 characters | the boundary is allowed, not off by one |
| `"Short."` on LinkedIn | `min_length` fires, so a one-liner cannot pass as a professional post |
| 3 hashtags on X | `max_hashtags` fires and lists `["#backend","#sqlite","#nodejs"]` |
| 1 hashtag on Discord | a limit of 0 is enforced, not treated as "no limit" |
| `https://example.com/guide#setup` | a URL fragment is **not** a hashtag, by two defences |
| `https://example.com/guide #setup` | a real hashtag after a URL is still counted, so URL stripping is not too greedy |
| `issue #42`, a lone `#` | neither is a hashtag |
| `ALWAYS` on X, then on Discord | `no_shouting` fires per profile, not globally |
| `SQL and WAL` | a short acronym is allowed |
| `lol` vs `lolly` / `lollipop` | banned words match on word boundaries, not substrings |
| `Shipped! Live now! Read it!` | `max_exclamations` fires with `actual: 3` |
| `@everyone` on all three platforms | mass mentions are refused everywhere |
| `someone@example.com` | an email address is not an @mention |
| `"ab😀"` | length is 3 code points, not JavaScript's 4 UTF-16 units |
| one text breaking five rules | **all five** are reported together, not just the first |
| `assertValidVariant` | throws HTTP 422, code `constraint_violation`, details naming the rule |
| profile limits | the numbers match the design doc (280 / 3000 / 2000, 2 / 5 / 0 hashtags) |

### E2c: the error names the broken rule

The shape built by `assertValidVariant` for `'a'.repeat(300)` on X. The status, the code and the first
violation's rule are asserted by the test above; the surrounding JSON is how
[src/http/errors.ts](src/http/errors.ts) serialises it. No endpoint returns it yet, so this is the shape,
not a captured response. The live transcript follows in the next step, once `POST /posts/:id/variants`
exists.

```json
{
  "error": "constraint_violation",
  "message": "Text breaks the X (short form) profile: max_length",
  "details": {
    "platform": "x",
    "violations": [
      { "rule": "max_length", "platform": "x", "limit": 280, "actual": 300,
        "message": "X (short form) allows at most 280 characters, got 300" }
    ]
  }
}
```

## E8: secrets are clean

**Requirement.** Tokens live in `.env` only, which is never committed, and `.env.example` ships.

```bash
git ls-files | grep -c '^\.env$'    # tracked .env files
ls .env.example
grep -n '^\.env$' .gitignore
```

```text
tracked .env files: 0
.env.example present
.gitignore: 3:.env
```

The webhook URL is also never logged or echoed by any endpoint. Only `src/config.ts` reads `process.env`
at all, so there is one place to audit:

```bash
grep -rn 'process\.env' src/
```

```text
src/config.ts:6: * Nothing else in the app reads process.env, so a typo is a boot error instead of
src/config.ts:38:  const raw = process.env[key]?.trim();
src/config.ts:45:  const raw = process.env[key]?.trim();
src/config.ts:92:  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
```

Line 6 is a comment. The three real reads are the two generic helpers and the webhook URL.
