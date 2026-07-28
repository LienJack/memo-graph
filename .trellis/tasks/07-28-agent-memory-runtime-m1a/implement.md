# M1A Implementation Checklist

## 1. Task and test scaffold

- [x] Validate and activate this child task.
- [x] Pin its branch and bounded implementation/check context.
- [x] Add storage, recovery, and benchmark scripts without weakening M0 gates.
- [x] Write failing tests for the invariants before production behavior.

## 2. Data root and migrations

- [x] Implement absolute/local/private data-root validation and directory
  creation.
- [x] Add `0001-evidence-ledger.sql` with canonical, idempotency, receipt,
  outbox, operations, and append-only constraints.
- [x] Add `0002-fts-baseline.sql` with FTS5 and projection health.
- [x] Implement forward-only migration discovery, hashing, application, drift
  rejection, and downgrade rejection.
- [x] Configure WAL, foreign keys, synchronous durability, busy handling,
  trusted-schema posture, defensive limits, and checkpoints.

## 3. Worker boundary

- [x] Add runtime-decoded worker request/response envelopes.
- [x] Implement the dedicated worker as the sole driver owner.
- [x] Implement a serialized writer queue with depth/age metrics.
- [x] Prove a slow synchronous worker operation does not block the caller event
  loop.
- [x] Map worker exit and SQLite errors to typed storage errors without content
  leakage.

## 4. Canonical L0 commit

- [x] Implement content-addressed blob verification and atomic writes.
- [x] Verify EvidenceRecord content hashes and Episode sealed hashes.
- [x] Atomically persist evidence, episode membership, epoch, FTS outbox,
  mutation receipt, and idempotency mapping.
- [x] Return stored receipts for identical retries and reject key/hash
  conflicts.
- [x] Enforce append-only canonical tables at the database boundary.

## 5. FTS5 derived lane

- [x] Implement idempotent FTS outbox draining.
- [x] Implement exact-scope search with typed OK, NO_MATCH, and DEGRADED
  results.
- [x] Implement observable projection health and deterministic FTS rebuild.
- [x] Prove read/search/rebuild cannot change canonical rows or ledger epoch.

## 6. Backup and recovery

- [x] Implement worker-owned checkpoint and verified backup.
- [x] Record backup manifests only after integrity and frontier verification.
- [x] Add one-shot crash-after-commit fault injection for recovery tests.
- [x] Prove restart retry returns the original receipt with no duplicates.
- [x] Prove migration drift and corrupt blob states fail closed.

## 7. Gate G1A

- [x] Run `pnpm test:contract` and `pnpm test:fixtures`.
- [x] Run `pnpm test:storage`.
- [x] Run `pnpm test:recovery -- writer-restart`.
- [x] Run storage baseline benchmark and record the workload actually tested.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, frozen install, and
  high-severity audit on Node 24.18.0.
- [x] Record implementation commit, lock/migration hashes, platform, test,
  recovery, performance, and open debt in
  `docs/evaluations/g1a-storage-decision.md`.
- [ ] Commit the completed M1A task, archive it, and record the Trellis session
  before activating M1B.
