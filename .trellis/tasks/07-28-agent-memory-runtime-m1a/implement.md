# M1A Implementation Checklist

## 1. Task and test scaffold

- [x] Validate and activate this child task.
- [x] Pin its branch and bounded implementation/check context.
- [ ] Add storage, recovery, and benchmark scripts without weakening M0 gates.
- [ ] Write failing tests for the invariants before production behavior.

## 2. Data root and migrations

- [ ] Implement absolute/local/private data-root validation and directory
  creation.
- [ ] Add `0001-evidence-ledger.sql` with canonical, idempotency, receipt,
  outbox, operations, and append-only constraints.
- [ ] Add `0002-fts-baseline.sql` with FTS5 and projection health.
- [ ] Implement forward-only migration discovery, hashing, application, drift
  rejection, and downgrade rejection.
- [ ] Configure WAL, foreign keys, synchronous durability, busy handling,
  trusted-schema posture, defensive limits, and checkpoints.

## 3. Worker boundary

- [ ] Add runtime-decoded worker request/response envelopes.
- [ ] Implement the dedicated worker as the sole driver owner.
- [ ] Implement a serialized writer queue with depth/age metrics.
- [ ] Prove a slow synchronous worker operation does not block the caller event
  loop.
- [ ] Map worker exit and SQLite errors to typed storage errors without content
  leakage.

## 4. Canonical L0 commit

- [ ] Implement content-addressed blob verification and atomic writes.
- [ ] Verify EvidenceRecord content hashes and Episode sealed hashes.
- [ ] Atomically persist evidence, episode membership, epoch, FTS outbox,
  mutation receipt, and idempotency mapping.
- [ ] Return stored receipts for identical retries and reject key/hash
  conflicts.
- [ ] Enforce append-only canonical tables at the database boundary.

## 5. FTS5 derived lane

- [ ] Implement idempotent FTS outbox draining.
- [ ] Implement exact-scope search with typed OK, NO_MATCH, and DEGRADED
  results.
- [ ] Implement observable projection health and deterministic FTS rebuild.
- [ ] Prove read/search/rebuild cannot change canonical rows or ledger epoch.

## 6. Backup and recovery

- [ ] Implement worker-owned checkpoint and verified backup.
- [ ] Record backup manifests only after integrity and frontier verification.
- [ ] Add one-shot crash-after-commit fault injection for recovery tests.
- [ ] Prove restart retry returns the original receipt with no duplicates.
- [ ] Prove migration drift and corrupt blob states fail closed.

## 7. Gate G1A

- [ ] Run `pnpm test:contract` and `pnpm test:fixtures`.
- [ ] Run `pnpm test:storage`.
- [ ] Run `pnpm test:recovery -- writer-restart`.
- [ ] Run storage baseline benchmark and record the workload actually tested.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, frozen install, and
  high-severity audit on Node 24.18.0.
- [ ] Record implementation commit, lock/migration hashes, platform, test,
  recovery, performance, and open debt in
  `docs/evaluations/g1a-storage-decision.md`.
- [ ] Commit the completed M1A task, archive it, and record the Trellis session
  before activating M1B.
