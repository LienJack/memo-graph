# Journal - LienJack (Part 1)

> AI development session journal
> Started: 2026-07-28

---



## Session 1: Close M0 contracts and G0

**Date**: 2026-07-28
**Task**: Close M0 contracts and G0
**Branch**: `codex/agent-memory-runtime-m0`

### Summary

Implemented and certified the governed M0 contract boundary, frozen replay corpus, pinned toolchain, MCP and SQLite compatibility evidence, and G0 GO decision.

### Main Changes

- Pinned Node 24.18.0, pnpm, TypeScript, Zod, MCP v2 server, and better-sqlite3 with a reproducible lockfile.
- Added runtime schemas, canonical hashes and receipts, 11 replay fixtures across calibration, holdout, and transfer partitions, plus ADRs and threat model.
- Recorded G0 GO against implementation commit e8ae579 and archived the M0 child while leaving the planning parent active.

### Git Commits

| Hash | Message |
|------|---------|
| `69975a9` | (see git log) |
| `d3e711b` | (see git log) |
| `e8ae579` | (see git log) |
| `8c8266d` | (see git log) |

### Testing

- [OK] Node 24.18.0: 33 contract tests and 3 fixture tests passed.
- [OK] lint, typecheck, build, frozen install, and high-severity audit passed.

### Status

[OK] **Completed**

### Next Steps

- Create and execute M1A for the SQLite authoritative ledger, migrations, FTS5, worker boundary, backup, and recovery.


## Session 2: Close M1A canonical SQLite storage

**Date**: 2026-07-28
**Task**: Close M1A canonical SQLite storage
**Branch**: `codex/agent-memory-runtime-m1a`

### Summary

Implemented and certified the M1A authoritative L0 SQLite ledger, worker isolation, idempotent receipts, FTS5, content-addressed blobs, backup/restore, and fail-closed encryption boundary.

### Main Changes

- Added two immutable migrations, private local data-root validation, append-only evidence/episode tables, atomic receipt/idempotency/outbox transactions, and a serialized dedicated storage worker.
- Added exact-scope FTS degradation/rebuild, verified SQLite/blob snapshots, empty-root restore, busy handling, crash-after-commit recovery, and metadata-only diagnostics.
- Rejected secret evidence and known cloud/removable roots until M6 encryption; recorded G1A GO without closing parent G1.

### Git Commits

| Hash | Message |
|------|---------|
| `11ed78a` | (see git log) |
| `365918b` | (see git log) |
| `335fcf2` | (see git log) |
| `97c66d1` | (see git log) |

### Testing

- [OK] Node 24.18.0: 33 contract, 3 fixture, 23 storage, and 1 recovery tests passed; lint, typecheck, build, frozen install, and audit passed.
- [OK] Small profile: 10,000 evidence, commit p95 0.788 ms, FTS search p95 0.338 ms; Expected/Stress and reader concurrency remain open.

### Status

[OK] **Completed**

### Next Steps

- Create M1B for local-principal binding, stdio MCP tools/resources, budgeted baseline context compilation, explicit Codex loop, and parent G1 evidence.


## Session 3: M1B governed stdio memory loop and G1

**Date**: 2026-07-28
**Task**: M1B governed stdio memory loop and G1
**Branch**: `codex/agent-memory-runtime-m1b`

### Summary

Implemented principal-bound official MCP stdio tools/resources, recall and Context persistence, budgeted L0 compiler, real cross-process explicit loop, Small-profile benchmark, and recorded G1 GO.

### Git Commits

| Hash | Message |
|------|---------|
| `9f510e5` | (see git log) |
| `cd10577` | (see git log) |
| `d097ca2` | (see git log) |

### Status

[OK] **Completed**
