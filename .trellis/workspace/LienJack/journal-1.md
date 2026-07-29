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


## Session 4: M2 Versioned L1 Governance G2

**Date**: 2026-07-29
**Task**: M2 Versioned L1 Governance G2
**Branch**: `codex/agent-memory-runtime-m2`

### Summary

Completed the mandated brainstorm, research, plan, and work pipeline for M2; implemented evidence-bound L1 admission, immutable revisions and CAS, governed Context, trusted approvals and user controls, tombstone-first purge, verified restore frontier, frozen replay evidence, operator documentation, and a GO-to-M3 G2 decision. Full review passed 28 files and 138 tests with no open P0/P1.

### Git Commits

| Hash | Message |
|------|---------|
| `8e15401` | (see git log) |
| `cfa659a` | (see git log) |
| `e0de085` | (see git log) |
| `f537586` | (see git log) |
| `f07126b` | (see git log) |
| `1b3deb6` | (see git log) |
| `d949b40` | (see git log) |
| `c7cf1c2` | (see git log) |
| `31959fc` | (see git log) |
| `66a954a` | (see git log) |
| `c273972` | (see git log) |

### Status

[OK] **Completed**


## Session 5: M3 layered Context Compiler HOLD

**Date**: 2026-07-29
**Task**: M3 layered Context Compiler HOLD
**Branch**: `codex/agent-memory-runtime-m3`

### Summary

Completed the Trellis-governed M3 requirements, research, plan, layered projection/runtime implementation, frozen G3 replay, and Tier 2 review. G3 is HOLD after three P1 retrieval/frontier defects and one P2 telemetry defect; M2 L0/L1 remains the accepted fallback and M4A/M4B/M5 stay closed.

### Git Commits

| Hash | Message |
|------|---------|
| `135f322` | (see git log) |
| `f6c10e4` | (see git log) |
| `c4472dd` | (see git log) |
| `da4bde7` | (see git log) |
| `7246c13` | (see git log) |
| `9767351` | (see git log) |
| `7314408` | (see git log) |
| `693218e` | (see git log) |
| `603f851` | (see git log) |
| `cc6b55f` | (see git log) |
| `5e4c754` | (see git log) |
| `ba20974` | (see git log) |

### Status

[OK] **Completed**


## Session 6: Complete H3 bounded recall remediation and record G3R GO

**Date**: 2026-07-29
**Task**: Complete H3 bounded recall remediation and record G3R GO
**Branch**: `codex/agent-memory-runtime-h3`

### Summary

Completed the Trellis H3 workflow, fixed bounded recall and scope-frontier correctness, refroze candidate 6224f78, recorded G3R GO, and archived the task.

### Main Changes

- Added bounded projection paging, exact source revalidation, V2 scope frontiers, and explicit relation truncation telemetry.
- Resolved the U8 cross-scope invalidation P1 so an affected pending scope cannot remove unrelated ready-scope projections.
- Recorded hash-bound G3R replay, performance, reproducibility, full-diff review, and GO decision evidence.

### Git Commits

| Hash | Message |
|------|---------|
| `cd50bfd` | (see git log) |
| `fea84db` | (see git log) |
| `ff116bc` | (see git log) |
| `30fb402` | (see git log) |
| `a970b34` | (see git log) |
| `f969e07` | (see git log) |
| `2e44f98` | (see git log) |
| `2a08cc4` | (see git log) |
| `d3e7132` | (see git log) |
| `58b35d4` | (see git log) |
| `ae07a24` | (see git log) |
| `6224f78` | (see git log) |
| `c092b26` | (see git log) |
| `4c68b77` | (see git log) |
| `37f9a54` | (see git log) |

### Testing

- [OK] pnpm test: 44 files, 237 passed, 1 skipped; lint, typecheck, and build passed.
- [OK] pnpm test:g3 and pnpm test:g3r:h3 passed; accepted M2 parity, 9 H3 regressions, Small/Expected benchmarks, and physical Small rebuild passed.
- [OK] pnpm audit --prod, pnpm verify:g3r, Trellis validation, JSON, Markdown fence, and diff checks passed.

### Status

[OK] **Completed**

### Next Steps

- Start M4A, M4B, or M5 only as a separate Trellis workflow; projection lanes remain disabled by default.


## Session 7: Complete M4A graph evaluation and record G4A NO-GO

**Date**: 2026-07-29
**Task**: Complete M4A graph evaluation and record G4A NO-GO
**Branch**: `codex/agent-memory-runtime-m4a`

### Summary

Completed the mandated brainstorm, research, plan, implementation, full-diff review, frozen G4A evaluation, and Trellis closure. G4A is NO-GO because structural value failed first and the resource gate also failed; SQLite adjacency remains the accepted fallback and graph stays default-off.

### Main Changes

- Qualified and pinned LadybugDB 0.18.3 behind an optional, killable child process while preserving SQLite authority.
- Implemented exact-scope graph delivery, deterministic rebuild, governed postvalidated recall, purge/recovery Oracles, and hash-bound evaluation evidence.
- Resolved nine P1 review/evidence defects before freezing candidate 36421f5; no unresolved P0/P1 remains.

### Git Commits

| Hash | Message |
|------|---------|
| `7384f74` | (see git log) |
| `d948d47` | (see git log) |
| `03f163e` | (see git log) |
| `fc0f15e` | (see git log) |
| `14ae2f0` | (see git log) |
| `0628e5b` | (see git log) |
| `78ccadb` | (see git log) |
| `eb98973` | (see git log) |
| `462197f` | (see git log) |
| `7b95743` | (see git log) |
| `e973511` | (see git log) |
| `1b4c7c7` | (see git log) |
| `fbc4b0d` | (see git log) |
| `ba0e883` | (see git log) |
| `dd5e668` | (see git log) |
| `f81b117` | (see git log) |
| `7ac39f1` | (see git log) |
| `8ce3ff3` | (see git log) |
| `4ddfaa7` | (see git log) |
| `5144452` | (see git log) |
| `36421f5` | (see git log) |
| `6238c48` | (see git log) |
| `a74301e` | (see git log) |

### Testing

- [OK] pnpm test: 60 files, 318 passed, 1 skipped; graph: 11 files, 37 passed; G3R: 8 files, 70 passed, 1 skipped.
- [OK] Build, lint, typecheck, frozen and no-optional installs, SQLite-only MCP smoke, migrations, audit, Trellis validation, and both evidence verifiers passed.
- [OK] G4A verifier confirmed NO-GO: 0 strict gains, one transfer regression, missing Expected native rebuild, and idle RSS above 128 MiB.

### Status

[OK] **Completed**

### Next Steps

- Start M4B as an independent Trellis brainstorm-research-plan-work workflow; G4A does not authorize M5 or M6.
