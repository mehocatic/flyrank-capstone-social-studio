# Build log

Honest record of how this was built: where AI (Claude Code) helped, where it was wrong, what changed.

## Phase 1: Design

- **2026-10-19: design doc drafted** ([docs/DESIGN.md](docs/DESIGN.md)).
  - AI helped: drafted the data model, the publish path (claim → write-ahead attempt → send → record) and the constraint profiles from my fixed decisions (SQLite job store, Discord webhook as the real target, two mocks, templates instead of AI).
  - Checked before deciding: a throwaway script confirmed that Node 24's built-in `node:sqlite` supports `UPDATE … RETURNING` (atomic claim) and a partial unique index (one success per job). It prints an ExperimentalWarning. It still beats `better-sqlite3`, which needs a native build on the reviewer's machine.
  - Decision: when a Discord send is ambiguous, the job is parked as `unknown` (at-most-once), not retried. A webhook has no idempotency key, so retrying could post twice.

## Phase 2: Ingestion and generation

- **2026-10-19: scaffold, config and schema.** `package.json`, `tsconfig.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), `src/config.ts`, `src/db/`, `GET /health`. Builds clean; `GET /health` and the 404 error shape verified by hand.
  - Dependencies: `express` only. `.env` is read by Node's own `process.loadEnvFile`, so no `dotenv`; SQLite is `node:sqlite`, so no native build.
  - AI got it wrong first: the initial import was `from './schema.ts'`, which TypeScript rejects for a compiled project (`.ts` imports need `allowImportingTsExtensions`, which only works with `noEmit`). Changed to `./schema.js`, the standard NodeNext style, where the source is `.ts` and the import names the emitted file.
  - My call, not the AI's default: config is validated once at boot and nothing else reads `process.env`. Proven by booting with `PLATFORMS` including `discord` and no webhook URL: it exits 1 with a message naming the fix instead of crashing later inside the worker.
  - Added a guard the design doc implies but did not state: `WORKER_LEASE_MS` must exceed `PUBLISH_TIMEOUT_MS`, else a lease can expire while a send is still in flight.
  - Node floor set to **24**, the version this was actually built and run on (24.14.0). An earlier draft claimed 22.13 from reading release notes. I removed that: a verified claim beats an assumed one, and nobody had run the code on 22.13.
- **2026-10-19: ingestion.** `POST /posts` (either `{url}` or `{markdown}`), `GET /posts/:id`, `GET /posts`. 13 cases checked by hand against a running server, including a real fetch of `https://example.com/` that extracted the title and body correctly.
  - No Markdown or HTML parser dependency. The system needs a title, plain prose and tags, so `src/posts/markdown.ts` does that with regexes. A real parser would be more correct on exotic input and more code than I can defend line by line.
  - AI got it wrong again, same root cause as the import: `node:sqlite` types every row as `Record<string, SQLOutputValue>`, so `.get(...) as PostRow` failed to compile ("neither type sufficiently overlaps"). Rather than scatter `as unknown as` casts, I added `queryOne` / `queryAll` / `execute` in `src/db/index.ts`. The unchecked cast now lives in one reviewable place, and the schema's CHECK constraints are what actually hold the union types honest.
  - Added beyond the design doc: an SSRF guard in `src/posts/fetchUrl.ts`. `POST /posts {url}` makes the server fetch an address a caller chose, so loopback, private and link-local addresses are refused. Verified with `169.254.169.254` (the cloud metadata address). The comment states the limit honestly: the check does not resolve DNS, so a hostname pointing at a private IP would still pass.
  - The URL is fetched **once**, at ingest. Generation reads only the stored row, so a variant cannot change later because the blog did. That is the brief's "stored post is the single source of truth".
