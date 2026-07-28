# Agent Memory Runtime M1A canonical SQLite ledger

## Goal

Implement the authoritative L0 SQLite ledger behind an asynchronous storage
client. M1A owns forward-only migrations, content-addressed blobs, FTS5,
dedicated-worker isolation, idempotent episode sealing, backup/restore
verification, and storage evidence. MCP transport and product handlers remain
in M1B.

## Authority

1. Product Contract R1-R3, R6-R13, R18-R19.
2. Parent `design.md` sections 4-5 and `implement.md` section 6.
3. G0 decision and ADR 0001.
4. Backend database, error, logging, quality, and directory specifications.

This child does not add or renumber product requirements.

## In scope

- A validated, private local data root with stable `ledger/`, `blobs/`, and
  `backups/` paths.
- Forward-only SQLite migrations for L0 events, episodes, artifact references,
  idempotency, mutation receipts, an outbox, FTS5, schema state, and backup
  manifests.
- WAL, foreign keys, defensive limits, explicit busy timeout, bounded
  checkpoint behavior, and append-only canonical tables.
- One serialized mutation queue and a dedicated worker that owns every
  synchronous driver call, including reads, checkpoints, and backups.
- Atomic commit of evidence, sealed episode, idempotency record, outbox jobs,
  ledger epoch, and durable receipt.
- Content-addressed blob writes with hash verification and atomic rename.
- Scope-bound FTS5 projection, explicit projection health, deterministic
  rebuild, and typed degraded/unavailable results.
- Crash-after-commit retry, restart, backup integrity, restore, and
  no-duplicate recovery tests.
- Metadata-only diagnostics and observable queue/checkpoint state.

## Out of scope

- MCP server startup, SDK tool registration, host integration, or approval UI.
- L1 admission, MemoryObject/MemoryRevision governance, correction, revoke, or
  purge.
- Context compilation, graph/vector projection, and learning behavior.
- Claiming Linux or Windows support before those environments execute the same
  recovery suite.

## Invariants

- SQLite is authoritative; FTS is rebuildable and cannot authorize content.
- Canonical evidence and sealed episodes are append-only.
- A reused idempotency key with the same request hash returns the byte-identical
  durable receipt; a different hash returns a typed conflict.
- The canonical transaction is committed before any success response.
- A worker crash after commit but before response cannot duplicate effects.
- Search always applies exact scope predicates and never fabricates results
  when FTS is pending, rebuilding, or unavailable.
- No runtime diagnostic contains inline content, blob bytes, or an FTS query.
- No package outside `storage-sqlite` imports `better-sqlite3`.

## Acceptance Criteria

- [x] `pnpm test:storage` passes schema, constraints, append-only,
  idempotency, scope isolation, blob, outbox, FTS, checkpoint, and backup tests.
- [x] `pnpm test:recovery -- writer-restart` proves crash-after-commit retry
  returns the original receipt and creates no duplicate episode/evidence rows.
- [x] A worker-blocking probe proves the caller event loop continues to make
  progress while SQLite work is running.
- [x] Forward migrations are recorded with immutable SHA-256 hashes and reject
  drift or downgrade.
- [x] The database and blob root are private by default and unsafe relative,
  root, URL-like, and symlink escape paths fail closed.
- [x] Canonical tables reject UPDATE/DELETE; projection and operational state
  may change only through named worker operations.
- [x] FTS can be dropped/rebuilt from SQLite without changing canonical hashes
  or ledger epoch.
- [x] Backup verification opens the copy, runs `integrity_check`, and matches
  the source canonical frontier.
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm build`, and the existing M0 suites
  remain green on Node 24.18.0.
- [ ] `docs/evaluations/g1a-storage-decision.md` records commit, lock,
  migration, platform, test, recovery, and known-debt evidence with `GO` or
  `HOLD`.

## Notes

- Parent gate G1 is not closed by M1A; it also requires the explicit MCP loop
  from M1B.
- If receipt durability, append-only enforcement, scope isolation, or restart
  idempotency fails, set G1A to `HOLD`, disable mutation work, and do not begin
  M1B writes.
