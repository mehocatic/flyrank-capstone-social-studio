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
  - AI got it wrong first: the initial import was `from './schema.ts'`, which TypeScript rejects for a compiled project (`.ts` imports need `allowImportingTsExtensions`, which only works with `noEmit`). Changed to `./schema.js` — the standard NodeNext style, where the source is `.ts` and the import names the emitted file.
  - My call, not the AI's default: config is validated once at boot and nothing else reads `process.env`. Proven by booting with `PLATFORMS` including `discord` and no webhook URL — it exits 1 with a message naming the fix instead of crashing later inside the worker.
  - Added a guard the design doc implies but did not state: `WORKER_LEASE_MS` must exceed `PUBLISH_TIMEOUT_MS`, else a lease can expire while a send is still in flight.
  - **Not verified yet:** `engines` says Node >= 22.13 (`node:sqlite`, `process.loadEnvFile` and `--disable-warning` all exist there), but everything so far has only been run on Node 24.14. To be checked on 22.13 before submission, or the floor gets raised to 24.
