# Build log

Honest record of how this was built: where AI (Claude Code) helped, where it was wrong, what changed.

## Phase 1: Design

- **2026-10-19: design doc drafted** ([docs/DESIGN.md](docs/DESIGN.md)).
  - AI helped: drafted the data model, the publish path (claim → write-ahead attempt → send → record) and the constraint profiles from my fixed decisions (SQLite job store, Discord webhook as the real target, two mocks, templates instead of AI).
  - Checked before deciding: a throwaway script confirmed that Node 24's built-in `node:sqlite` supports `UPDATE … RETURNING` (atomic claim) and a partial unique index (one success per job). It prints an ExperimentalWarning. It still beats `better-sqlite3`, which needs a native build on the reviewer's machine.
  - Decision: when a Discord send is ambiguous, the job is parked as `unknown` (at-most-once), not retried. A webhook has no idempotency key, so retrying could post twice.
