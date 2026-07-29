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


## Session 8: Complete M4B local vector adoption decision

**Date**: 2026-07-29
**Task**: Complete M4B local vector adoption decision
**Branch**: `codex/agent-memory-runtime-m4b`

### Summary

Completed the Trellis M4B pipeline from frozen semantic gap through governed local vector implementation, adversarial recovery fixes, reproducible evaluation, and terminal G4B NO-GO. SQLite remains authoritative; vector stays disabled and the accepted FTS5, layered, and SQLite-relation runtime is the M5 baseline.

### Main Changes

- Implemented optional exact-scope vector projection, process isolation, canonical postvalidation, lifecycle propagation, rebuild, epoch migration, typed fallback, and default-off MCP composition.
- Closed P1 deadline, generation-cycle, missing-index, and ambiguous-ack recovery defects with deterministic Oracles.
- Bound candidate 3eec711, dependency lock, local model files, embedding epoch, reports, environment, review, runbook, ADR, and final NO-GO decision in a machine-verifiable evidence chain.

### Git Commits

| Hash | Message |
|------|---------|
| `bd8e50e` | (see git log) |
| `92b632e` | (see git log) |
| `a429f04` | (see git log) |
| `a8714da` | (see git log) |
| `38e5196` | (see git log) |
| `114dfd0` | (see git log) |
| `6699e61` | (see git log) |
| `4873f03` | (see git log) |
| `eb8ba82` | (see git log) |
| `8a1afdc` | (see git log) |
| `b1f7b29` | (see git log) |
| `c185a41` | (see git log) |
| `b860ad3` | (see git log) |
| `6d0f1db` | (see git log) |
| `aa56340` | (see git log) |
| `3eec711` | (see git log) |
| `7d183f6` | (see git log) |
| `3213f74` | (see git log) |

### Testing

- [OK] Final pnpm test: 77 files, 401 passed, 1 environment-gated skip with the qualified local model configured.
- [OK] G4B artifact integrity: 3/3 passed; verifier reports NO-GO because utility_gate and resource_gate are false; lint, typecheck, build, high-severity audit, clean offline no-optional startup, Trellis validation, and diff checks passed.

### Status

[OK] **Completed**

### Next Steps

- Start M5 Learning Lab through ce-brainstorm -> research-to-article -> ce-plan -> ce-work under a new Trellis child.
- Bind G4A graph NO-GO and G4B vector NO-GO retrieval configuration into every no-candidate/current/candidate learning arm and release receipt.


## Session 9: M5 Governed Learning Lab completed

**Date**: 2026-07-30
**Task**: M5 Governed Learning Lab completed
**Branch**: `codex/agent-memory-runtime-m5`

### Summary

Completed the Trellis M5 workflow from brainstorm through governed implementation and a verifier-backed G5 GO for one exact local synthetic release path. Baseline branch head was b2a36ab5e6b3e8da04b3b4ed158171cb83e9491b; graph/vector remain NO-GO and M6 remains pending.

### Main Changes

- Ran ce-brainstorm, research-to-article run RUN20260729-183807-m5-governed-learning-lif-896401 with 27/27 supported claims, ce-plan, and ce-work under Trellis.
- Delivered U1-U9: strict learning contracts, SQLite learning authority, privacy-minimal traces, smallest reversible candidates, protected three-arm evaluation, lifecycle/canary authority, atomic release/rollback, pause/resume, MCP parity, review remediation, G5 evidence, and decision.
- Tested implementation 91d810efe17632e64f5e9a3ddae81f8e9f0b9985; evidence commit b9c0907745cedf3315d7ab3f42a39c9afb8790eb; decision commit 7c71c455bc8837c013220440b8d1e1ce9903bd29; archived by 7e2ac788685f75468e4a5fcd64eee8058b73a81c.
- G5 GO is limited to release release:a8f7214a0c8a8db3b5f2515649b06c0ffc855ab68 and exact rollback to base null; automatic publication stays disabled.

### Git Commits

| Hash | Message |
|------|---------|
| `19bb6124d3a484fa775d449096c75d4bd0527ae0` | (see git log) |
| `0a4a44d868160fd272ccef68baa7c41d020ba115` | (see git log) |
| `e102b94c1c2da7f38cd19dcd63c3cf8891fff2a2` | (see git log) |
| `6b95263a087deb67995af117ff6285711b8fd9df` | (see git log) |
| `038aecdfe19dec067d158f42d3cc0947e6aa71a4` | (see git log) |
| `fe79506842cf4b5ea4e594ff17e8fbac2e79dc9f` | (see git log) |
| `a3ddae7770734633c435e9fc156187eabc24da7d` | (see git log) |
| `2f9a74ff29dd22c9216fb499f9588b625261e445` | (see git log) |
| `09be40ccba00cc3f1f99322399536fc8008d1830` | (see git log) |
| `de1fdda7311c847a412f53236bd8bc8abf8ee4d8` | (see git log) |
| `946d2a8ee5fb59549678779aee5906397422c3a6` | (see git log) |
| `02bb7a1824e710b0736ee6e35c02b7d7e8925abc` | (see git log) |
| `91d810efe17632e64f5e9a3ddae81f8e9f0b9985` | (see git log) |
| `b9c0907745cedf3315d7ab3f42a39c9afb8790eb` | (see git log) |
| `7c71c455bc8837c013220440b8d1e1ce9903bd29` | (see git log) |

### Testing

- [OK] Full repository gate: 98 test files passed, 481 tests passed, 6 skipped; lint, typecheck, build, high-level audit, focused artifact integrity, and pnpm verify:g5 passed.
- [OK] Manifest sha256:12fe4d89de233dbe43ae3e1c416ca58a1e07684ed9602085416e2e40db6c6fac; verifier returned ELIGIBLE_FOR_U9 with zero unresolved P0/P1 review findings.

### Status

[OK] **Completed**

### Next Steps

- Create the M6 child under parent 07-28-agent-memory-runtime and run ce-brainstorm -> research-to-article -> ce-plan -> ce-work before G6.
- Carry schema, tombstone, projection, learning release/control, and purge frontiers through backup/restore, migration, disk/WAL, observability, fault drills, runbooks, and final release evidence.
