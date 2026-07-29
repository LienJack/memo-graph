# Agent Memory Runtime M4A — Execution Checklist

## 1. Execution contract

This checklist implements M4A only. Product requirements keep their existing
R8, R12, R14, R19, and R20 identities. Product Contract R9 remains the
independent M4B vector boundary. Work is test-first, dependency ordered, and
committed once per completed logical unit.

Use Node `24.18.0` and pnpm `10.33.2` for every meaningful verification:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
```

### Commit policy

| Unit | Commit intent |
| --- | --- |
| U1 | `feat(graph): freeze adoption contracts and corpus` |
| U2 | `feat(graph): isolate LadybugDB process` |
| U3 | `feat(storage): persist graph delivery checkpoints` |
| U4 | `feat(graph): project and rebuild exact scopes` |
| U5 | `feat(memory): add governed graph recall lane` |
| U6 | `test(graph): close governance and recovery oracles` |
| U7 | `test(graph): freeze G4A replay and resources` |
| U8 | `docs(graph): bind G4A verification evidence` |
| U9 | `docs(graph): record G4A decision` |

Before each commit:

- run the unit's focused verification;
- run lint/typecheck/build whenever public or cross-package contracts change;
- run `git diff --check`;
- inspect staged paths and exclude unrelated user work;
- record the exact commit in the next dependent artifact.

### Hard-stop rule

U2 is a mandatory containment gate. If the parent process cannot:

1. return a typed SQLite fallback by p95 100 ms after the 75 ms graph
   deadline;
2. terminate/quarantine the native child;
3. reopen or rebuild the graph without publishing corruption; and
4. continue SQLite-only operation,

then mark U3–U8 skipped with evidence and proceed directly to U9 `NO-GO`.

Any later critical governance, privacy, purge, or authority failure also stops
feature expansion and proceeds to the decision path.

## 2. Non-negotiable invariants

- SQLite owns identity, authority, scope, lifecycle, validity, sensitivity,
  evidence, tombstones, deletion receipts, projection frontier, and Context
  receipts.
- LadybugDB stores only rebuildable IDs, hashes, epochs, and lineage metadata.
- Native graph work never runs in the MCP process.
- The wrapper timeout is cooperative; the parent process deadline is final.
- Graph starts are SQLite-approved and exact-scope.
- Every graph path element is postvalidated in SQLite.
- Incomplete graph work is degraded and cannot be clean `NO_MATCH`.
- Correction, block, revoke, tombstone, and purge suppress the next read before
  physical graph convergence.
- A graph failure never blocks valid SQLite mutation, delete, restore, or
  recall.
- Incremental exact-scope state and full rebuild have the same canonical
  logical digest.
- The six cases, partitions, thresholds, and expected results freeze before
  adapter tuning.
- Holdout and transfer payloads are evaluation-only.
- Graph-disabled behavior remains equal to accepted G3R.
- `relation_graph` stays disabled by default in GO and NO-GO outcomes.
- M4B, M5, and M6 remain outside this task.

## 3. U1 — Freeze contracts, structural corpus, and thresholds

**Requirements:** R8, R12, R19–R20; F1/F3/F4;
M4A-AC1/M4A-AC5/M4A-AC8/M4A-AC9.

**Depends on:** None.

**Files:**

- `packages/contracts/src/graph.ts`
- `packages/contracts/src/projections.ts`
- `packages/contracts/src/replay.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/receipts.ts`
- `packages/contracts/src/index.ts`
- `fixtures/g4a/manifest.json`
- `fixtures/g4a/cases/*.json`
- `tests/contract/graph-store.contract.test.ts`
- `tests/contract/projections.contract.test.ts`
- `tests/contract/mcp.contract.test.ts`
- `tests/contract/receipts.contract.test.ts`
- `tests/fixtures/g4a-overlay.fixture.test.ts`

### Test-first checklist

- [x] Add valid minimal graph node, edge, scope snapshot, checkpoint, delivery
      receipt, backend identity, and ordered path fixtures.
- [x] Reject graph nodes or edges that contain rendered memory content,
      evidence bodies, approvals, ACLs, or deletion receipts.
- [x] Reject mismatched principal, exact scope, lifecycle, validity, epoch,
      hash, transform, or lineage across snapshot elements.
- [x] Reject duplicate node, edge, revision, relation, evidence, or path
      identities.
- [x] Prove unordered physical input normalizes to one canonical logical
      digest.
- [x] Prove changed scope, edge direction, validity, hash, or lineage changes
      the digest.
- [x] Reject graph queries with no explicit depth, starts, path/result bound,
      or parent deadline.
- [x] Reject raw Cypher, caller-provided graph paths, path escape, symlink
      substitution, or unbounded relation allowlists.
- [x] Reject a partial/incomplete graph result without a stable reason.
- [x] Add `relation_graph` lane tests while preserving `relation_sqlite`.
- [x] Add graph starts, path/result, depth, timeout, and process bounded-work
      categories with count invariants.
- [x] Prove request graph limits can only narrow operator policy.
- [x] Prove disabled graph lane reports zero candidates/selections.
- [x] Prove old G3 lane policies, Contexts, receipts, and hashes remain
      unchanged.
- [x] Freeze six case bodies with two calibration, two holdout, and two
      transfer partitions.
- [x] Freeze exact expected revision sets, ordered proof paths, evidence
      lineage, completeness, and abstention.
- [x] Freeze material gain: three strict improvements, including one holdout
      and one transfer, with no regression.
- [x] Define a strict improvement as C matching the complete expected
      assertions while both A and B fail at least one under identical
      semantics and limits; reject candidate-count, ordering-only, or
      latency-only credit.
- [x] Freeze host deadline, fallback, latency, startup, rebuild, disk, install,
      and RSS thresholds.
- [x] Add fixture tests that reject any case, partition, threshold, or expected
      result hash drift.
- [x] Add partition-access tests that prevent tuning code from opening
      holdout/transfer payloads.

### Implementation checklist

- [x] Define backend/native identity without importing LadybugDB types.
- [x] Define minimal graph node and edge envelopes.
- [x] Define exact-scope graph snapshot and canonical logical digest builder.
- [x] Define graph delivery/checkpoint/rebuild evidence.
- [x] Define bounded graph query and ordered path evidence.
- [x] Define process health and typed failure/degradation categories.
- [x] Extend lane policy, telemetry, Context, receipt, and replay contracts
      through optional/versioned fields.
- [x] Add `relation_graph` to every exhaustive lane mapping and ensure old
      callers are not default-enabled.
- [x] Create immutable G4A manifest and case files.
- [x] Export all new public schemas, builders, and types.

### Focused verification

```bash
pnpm vitest run \
  tests/contract/graph-store.contract.test.ts \
  tests/contract/projections.contract.test.ts \
  tests/contract/mcp.contract.test.ts \
  tests/contract/receipts.contract.test.ts \
  tests/fixtures/g4a-overlay.fixture.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Contract invalid/boundary cases fail for the intended reason.
- [x] G3 artifact compatibility is exact.
- [x] G4A corpus and threshold hashes are recorded.
- [x] Create the U1 commit.

**Rollback point:** revert U1; no dependency, migration, or graph state exists.

## 4. U2 — Process-isolated LadybugDB GraphStore

**Requirements:** R8, R14, R19–R20; F1/F3;
M4A-AC1/M4A-AC6/M4A-AC7.

**Depends on:** U1.

**Files:**

- `packages/graph-projection/package.json`
- `packages/graph-projection/tsconfig.json`
- `packages/graph-projection/src/graph-store.ts`
- `packages/graph-projection/src/process-host.ts`
- `packages/graph-projection/src/ladybug-process.ts`
- `packages/graph-projection/src/ladybug-adapter.ts`
- `packages/graph-projection/src/logical-digest.ts`
- `packages/graph-projection/src/index.ts`
- `package.json`
- `pnpm-lock.yaml`
- `tests/contract/graph-store.contract.test.ts`
- `tests/recovery/graph-process.recovery.test.ts`
- `tests/security/graph-process-protocol.test.ts`

### Test-first checklist

- [x] Prove the package top level imports with optional LadybugDB absent.
- [x] Prove `pnpm install --frozen-lockfile --no-optional`, build, and MCP
      SQLite-only startup succeed without the LadybugDB native dependency.
- [x] Reject startup when package version, storage version, platform,
      architecture, or native binary identity differs from configuration.
- [x] Prove a valid child reports exact backend/native identity.
- [x] Reject oversized, malformed, unknown-version, unknown-operation,
      duplicate-ID, or late IPC messages.
- [x] Reject graph paths outside the canonical data root and symlink
      substitution.
- [x] Prove child environment excludes unrelated parent secrets and paths.
- [x] Prove documentation and health evidence describe the child as
      crash/availability containment, not an OS sandbox or malicious-native
      defense.
- [x] Prove only closed typed query operations reach the adapter; raw Cypher
      is rejected before IPC.
- [x] Prove one read/write child owns one database path.
- [x] Prove concurrent writes are serialized and concurrent query bounds are
      enforced.
- [x] Prove schema creation, scope replacement, scope delete, bounded path,
      logical snapshot, close, and reopen.
- [x] Prove explicit transaction rollback leaves no partial node/edge state.
- [x] Start an adversarial native query and prove the parent returns typed
      fallback by the 75 ms deadline.
- [x] Measure at least 100 timeout/fallback samples and require p95 <=100 ms.
- [x] Kill the child during a query and prove the parent remains responsive.
- [x] Kill the child during an uncommitted write and prove reopen has only the
      prior committed logical digest.
- [x] Prove duplicate, late, or post-timeout response cannot satisfy another
      request.
- [x] Prove replacement starts outside the timed-out request critical path.
- [x] Prove a replacement child becomes healthy within 2 seconds.
- [x] Repeatedly fail the child and prove restart rate limiting/circuit breaker
      prevents fork, CPU, timer, and process storms.
- [x] Prove parent shutdown leaves no orphan child.
- [x] Prove process stderr/logs contain no graph payload or memory content.
- [x] Prove a graph crash cannot close or corrupt SQLite storage.

### Implementation checklist

- [x] Pin `@ladybugdb/core@0.18.3` and approved native build metadata.
- [x] Declare it as the graph package's optional dependency and add the graph
      package to the root workspace build order after storage and before MCP.
- [x] Keep the memory kernel dependent only on a backend-neutral retriever
      port; compose the optional graph package at the MCP boundary without a
      package cycle.
- [x] Add the workspace package without making graph a default lane.
- [x] Dynamically import LadybugDB only inside the child.
- [x] Implement runtime-decoded bounded IPC.
- [x] Derive and confine graph paths; construct a minimal child environment.
- [x] Implement parent request identity, deadline, response matching, and
      quarantine state.
- [x] Implement OS process termination and non-blocking replacement.
- [x] Implement restart rate limit and bounded circuit-breaker cooldown.
- [x] Use async graph APIs for user/structural queries; ban sync query path.
- [x] Keep explicit transactions for scope writes and lifecycle operations.
- [x] Close native results, connections, database, IPC, and timers.
- [x] Compute logical digest through the shared contract builder.
- [x] Emit content-free stable failure categories.

### Focused verification

```bash
pnpm vitest run \
  tests/contract/graph-store.contract.test.ts \
  tests/recovery/graph-process.recovery.test.ts \
  tests/security/graph-process-protocol.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Native identity and dependency hashes are recorded.
- [x] Timeout fallback p95 and process replacement threshold pass.
- [x] Kill-during-query/write recovery passes without SQLite impact.
- [x] Decide whether the hard-stop gate permits U3.
- [x] Create the U2 commit.

**Rollback point:** remove/disable the optional graph package; SQLite runtime
is unchanged.

## 5. U3 — SQLite graph-delivery queue and scope checkpoints

**Requirements:** R8, R14, R19; F2/F3;
M4A-AC4/M4A-AC5/M4A-AC7.

**Depends on:** U2 hard-stop pass.

**Files:**

- `migrations/0012-graph-projection-delivery.sql`
- `packages/storage-sqlite/src/graph-projection-repository.ts`
- `packages/storage-sqlite/src/migrations.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/projection-repository.ts`
- `packages/storage-sqlite/src/projection-effects.ts`
- `packages/storage-sqlite/src/index.ts`
- `tests/storage/graph-projection-schema.integration.test.ts`
- `tests/storage/data-root-and-migrations.integration.test.ts`
- `tests/governance/derived-invalidation.integration.test.ts`

### Test-first checklist

- [x] Apply migration `0012` after `0011` on empty and populated databases.
- [x] Prove old canonical and projection rows remain byte/logically unchanged.
- [x] Prove SQLite-only open and queries work with no graph package/process.
- [x] Create distinct graph checkpoints for two exact scopes and one backend.
- [x] Reject decreasing ledger, tombstone, projection, or graph epochs.
- [x] Reject ready scope without non-null frontier, digest, and backend
      identity.
- [x] Reject content or evidence body in job, checkpoint, receipt, or error.
- [x] Prove projection batch apply enqueues the exact affected scope.
- [x] Prove correction/revoke/tombstone/purge marks only affected graph scope
      pending in the same canonical transaction.
- [x] Prove unrelated scope remains ready and unchanged.
- [x] Prove stable job identity makes duplicate canonical effect idempotent.
- [x] Prove one worker claims a job lease and another cannot steal it early.
- [x] Prove expired lease can be reclaimed with attempts preserved.
- [x] Prove stale frontier job cannot publish ready.
- [x] Prove apply compares job lease, expected frontier, backend, and digest.
- [x] Prove failure preserves pending/unavailable state and typed retry
      evidence.
- [x] Prove reset/rebuild marks the intended scopes without deleting history.
- [x] Runtime-decode every new storage worker command and result.
- [x] Prove restore opens with graph scopes unavailable until reverified.

### Implementation checklist

- [x] Add guarded append-only delivery/checkpoint/receipt tables and indexes.
- [x] Add stable job IDs, bounded lease/attempt state, and content-free error
      categories.
- [x] Add exact-scope canonical graph snapshot query and expected logical
      digest.
- [x] Couple graph pending/enqueue to projection apply/invalidation
      transactions.
- [x] Add claim, apply, fail, reset, rebuild, scope state, counts, and health
      repository operations.
- [x] Route every operation through database, worker, client, and public
      storage exports.
- [x] Preserve one serialized SQLite writer and short transactions.
- [x] Keep absent graph state disabled/inert rather than failed.

### Focused verification

```bash
pnpm vitest run \
  tests/storage/graph-projection-schema.integration.test.ts \
  tests/storage/data-root-and-migrations.integration.test.ts \
  tests/governance/derived-invalidation.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Migration and old-database compatibility pass.
- [x] Scope isolation, monotonicity, lease/retry, and stale apply pass.
- [x] Canonical mutation and graph pending evidence are atomic.
- [x] Create the U3 commit.

**Recorded evidence:**

- Focused U3 verification: 3 files, 15 tests passed.
- Full verification: 49 files, 273 tests passed, 1 skipped.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed on Node 24.18.0.
- Isolated accepted G3R verification passed for
  `6224f782c86712488d416d8101ef7c9fa477c0ae`.

**Rollback point:** code may ignore the additive graph tables; leave them inert.

## 6. U4 — Exact-scope projector and deterministic rebuild

**Requirements:** R8, R14, R19; F2/F3;
M4A-AC3/M4A-AC4/M4A-AC5/M4A-AC7.

**Depends on:** U3.

**Files:**

- `packages/graph-projection/src/projector.ts`
- `packages/graph-projection/src/rebuilder.ts`
- `packages/graph-projection/src/sqlite-baseline.ts`
- `packages/graph-projection/src/logical-digest.ts`
- `packages/storage-sqlite/src/graph-projection-repository.ts`
- `tests/integration/graph-projection.integration.test.ts`
- `tests/recovery/graph-rebuild.recovery.test.ts`
- `tests/recovery/graph-backup-restore.test.ts`

### Test-first checklist

- [x] Project one exact scope with topic, scenario, procedure, relation, core,
      and evidence-lineage identities.
- [x] Prove graph nodes/edges contain IDs/hashes/epochs only, no memory text.
- [x] Prove scope replacement removes obsolete edges/nodes and preserves
      unrelated scopes.
- [x] Prove graph scope logical digest equals SQLite expected digest.
- [x] Prove a digest mismatch fails the job and leaves scope non-ready.
- [x] Prove duplicate job and replay after crash converge idempotently.
- [x] Prove a job whose canonical frontier changes before write is abandoned.
- [x] Prove a frontier change after graph write cannot publish stale ready.
- [x] Kill the child before scope transaction commit and prove no partial
      scope.
- [x] Kill the child after graph commit but before SQLite checkpoint and prove
      safe idempotent replay.
- [x] Build the same logical graph through different scope/job order and prove
      equal digest.
- [x] Run full rebuild into a fresh path and compare every scope plus global
      digest.
- [x] Close/reopen the rebuilt path and repeat the digest comparison.
- [x] Prove physical graph file hashes may differ while logical equality
      passes.
- [x] Corrupt the rebuild target and prove it is never published.
- [x] Restore SQLite plus stale/missing graph and prove graph remains
      unavailable until rebuild.
- [x] Prove backup/import/rebuild cannot publish a graph whose digest differs
      from restored SQLite.

### Implementation checklist

- [x] Convert exact-scope canonical snapshot to minimal graph node/edge
      envelopes.
- [x] Implement an evaluation-only deterministic graph-free reference over
      the same bounded SQLite slice, typed/shortest-path semantics, tie-breaks,
      and limits as the graph arm.
- [x] Recheck job/frontier before child dispatch.
- [x] Replace one exact scope inside one graph transaction.
- [x] Read back and compare canonical scope digest.
- [x] Advance SQLite checkpoint only after lease/frontier/digest equality.
- [x] Implement bounded claim/drain loop with idempotent retry.
- [x] Implement fresh-path full rebuild and stable scope enumeration.
- [x] Verify close/reopen before publish.
- [x] Quarantine failed/corrupt targets.
- [x] Record content-free projection and rebuild receipts.

### Focused verification

```bash
pnpm vitest run \
  tests/integration/graph-projection.integration.test.ts \
  tests/recovery/graph-rebuild.recovery.test.ts \
  tests/recovery/graph-backup-restore.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Scope replacement and full rebuild logical equality pass.
- [x] Crash windows and stale frontier cannot publish.
- [x] Restore trusts SQLite, not graph backup.
- [x] Create the U4 commit.

**Recorded evidence:**

- Focused U4 verification: 3 files, 10 tests passed.
- Full verification: 52 files, 283 tests passed, 1 skipped.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed on Node 24.18.0.
- The current candidate lock hash is
  `sha256:2133284bb0e8e6fdb6e723cf6e160ad6e271261f1e9fd79ec63309fe267094ec`;
  the U2 native binary hash remains
  `sha256:57e07aa4aaaae7556c414ce9bfddb24f3a6e1e6b1b4a07882e3feb5e8261c6aa`.

**Rollback point:** stop projector, mark graph unavailable, use SQLite lanes.

## 7. U5 — Governed graph recall lane and Context integration

**Requirements:** R8, R12, R14, R19; F3;
M4A-AC4/M4A-AC5/M4A-AC6/M4A-AC7.

**Depends on:** U4.

**Files:**

- `packages/graph-projection/src/graph-retriever.ts`
- `packages/memory-kernel/src/lane-retrievers.ts`
- `packages/memory-kernel/src/recall-orchestrator.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/context-compiler/src/hard-filters.ts`
- `packages/context-compiler/src/receipt-builder.ts`
- `packages/context-compiler/src/index.ts`
- `packages/mcp-server/src/index.ts`
- `packages/mcp-server/src/cli.ts`
- `tests/integration/graph-recall.integration.test.ts`
- `tests/integration/layered-recall.integration.test.ts`
- `tests/compiler/layered-context-compiler.test.ts`
- `tests/mcp/context-compiler.test.ts`

### Test-first checklist

- [x] Prove default runtime and MCP policy excludes `relation_graph`.
- [x] Prove request cannot enable graph when operator policy denies it.
- [x] Prove explicit permitted graph lane starts the optional retriever only
      when dependency/process/checkpoint are healthy.
- [x] Build starts only from SQLite-approved exact-scope revisions.
- [x] Build a canonical SQLite bounded structural slice with allowed relation
      revision IDs and exact start/fanout/work counts.
- [x] Prove the graph query cannot traverse outside the SQLite allowlist.
- [x] Reject graph query before dispatch when scope checkpoint is pending,
      stale, rebuilding, unavailable, wrong backend, or wrong frontier.
- [x] Return exact typed explanatory path and shortest valid path fixtures.
- [x] Enforce relation pattern, direction, `as_of`, depth, path/result, and
      parent deadline.
- [x] Prove raw query text cannot be supplied through MCP, kernel, retriever,
      IPC, or GraphStore contracts.
- [x] Prove start truncation and graph path/result truncation have separate
      counts/reasons.
- [x] Prove timeout, result+1, process exit, or unknown backend work is
      incomplete/degraded.
- [x] Prove truncated empty graph result cannot be `NO_MATCH`.
- [x] Revalidate every node and edge identity in one or bounded exact SQLite
      snapshot.
- [x] Reject whole path if any node/edge is missing, stale, wrong scope,
      outside validity, blocked, revoked, tombstoned, purged, or invalidated.
- [x] Reject whole path if evidence/lower-layer lineage or graph frontier
      differs.
- [x] Prove graph score/path length cannot override a canonical exclusion.
- [x] Prove correction between graph response and postvalidation excludes the
      path.
- [x] Prove unrelated valid path remains eligible.
- [x] Seal ordered proof IDs, query hash, frontier, completeness, counts,
      elapsed time, and reasons into Context/receipt.
- [x] Prove receipt bytes do not include graph database content or diagnostic
      payload.
- [x] Prove graph failure retains `relation_sqlite` and `recent_l1`.
- [x] Prove graph-disabled candidate produces accepted G3R semantic outputs.
- [x] Prove graph package absent still starts MCP and serves SQLite tools.

### Implementation checklist

- [x] Extend lane retrieval composition without creating package cycles.
- [x] Select canonical starts and current exact scope checkpoint.
- [x] Reuse SQLite bounded relation traversal to produce the structural
      allowlist and authoritative fanout/work telemetry.
- [x] Dispatch only bounded, decoded graph query requests.
- [x] Convert graph paths to raw ID/hash evidence, not final content.
- [x] Batch exact canonical node/edge/source validation.
- [x] Attribute every exclusion/degradation to graph telemetry.
- [x] Keep clean no-match conditional on complete graph and active fallback
      work.
- [x] Extend compiler hard filters and receipt sealing for graph proof paths.
- [x] Add explicit optional graph configuration with default disabled.
- [x] Keep SQLite-only startup and shutdown independent of graph child.

### Focused verification

```bash
pnpm vitest run \
  tests/integration/graph-recall.integration.test.ts \
  tests/integration/layered-recall.integration.test.ts \
  tests/compiler/layered-context-compiler.test.ts \
  tests/mcp/context-compiler.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Every graph result has live canonical node/edge/evidence proof.
- [x] All incomplete/failure modes degrade and fall back honestly.
- [x] Default-off and graph-absent compatibility pass.
- [x] Create the U5 commit.

**Recorded evidence:**

- Focused U5 verification: 4 files, 38 tests passed.
- Full verification: 53 files, 295 tests passed, 1 skipped.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, and the accepted G3R replay
  passed on Node 24.18.0.
- `pnpm install --frozen-lockfile --no-optional`, runtime build, and direct
  stdio MCP smoke passed with 13 tools, ledger epoch 0, and graph disabled.
- The U5 candidate lock hash is
  `sha256:4ecf84c7b6b15287f83c346a764742843ae795f099d61c1f34bbcad6864b6066`.
- Graph startup is lazy after policy intersection and a ready exact-scope
  checkpoint; an unavailable optional dependency is cached for the runtime
  lifetime to prevent process-start storms.

**Rollback point:** disable `relation_graph`; keep additive state and graph file
for inspection while serving SQLite.

## 8. U6 — Governance, purge, privacy, and recovery Oracles

**Requirements:** R8, R14, R19–R20; F2/F3;
M4A-AC4/M4A-AC5/M4A-AC6/M4A-AC7.

**Depends on:** U5.

**Files:**

- `tests/governance/graph-purge-propagation.test.ts`
- `tests/governance/graph-correction.integration.test.ts`
- `tests/recovery/graph-rebuild.test.ts`
- `tests/recovery/graph-backup-restore.test.ts`
- `tests/recovery/graph-outage.recovery.test.ts`
- `tests/security/graph-content-residual.test.ts`
- `docs/runbooks/graph-rebuild.md`
- `packages/graph-projection/src/projector.ts`
- `packages/graph-projection/src/rebuilder.ts`
- `packages/graph-projection/src/graph-retriever.ts`

### Test-first checklist

- [x] Correct an intermediate path revision and prove immediate suppression
      before graph delivery drains.
- [x] Demote, usage block, revoke, tombstone, and purge each intermediate
      node/edge and prove next-read suppression.
- [x] Prove correction/revoke in scope A does not change scope B readiness or
      result.
- [x] Prove concurrent graph response cannot outrun a canonical frontier
      change.
- [x] Prove repeated invalidation and delivery are idempotent.
- [x] Prove a failed delete/replacement leaves scope pending and path excluded.
- [x] Scan live graph, WAL/checkpoint files, export/import, backup, IPC,
      stderr, logs, error receipts, benchmark reports, and test artifacts for
      purged plaintext.
- [x] Prove graph database missing at startup yields typed SQLite fallback.
- [x] Prove locked database yields typed fallback and bounded restart/retry.
- [x] Prove child crash during query and write yields typed fallback.
- [x] Prove malformed child response cannot enter Context.
- [x] Prove deliberate graph corruption quarantines the store and starts
      rebuild without affecting SQLite.
- [x] Prove backup/restore marks graph unavailable until logical equality.
- [x] Prove graph backup with stale extra path cannot resurrect it.
- [x] Prove full graph deletion and rebuild preserve authoritative memory.
- [x] Prove no failure emits a memory-content diagnostic.
- [x] Prove repeated outage does not create unbounded child processes,
      timers, leases, queue work, or disk growth.
- [x] Prove the runbook commands/steps identify active path, frontier, digest,
      fallback, and publish evidence without exposing content.

### Implementation checklist

- [x] Complete stable lifecycle/failure category mapping.
- [x] Ensure canonical effects mark graph scope pending synchronously.
- [x] Ensure projector removes or replaces stale scope state.
- [x] Keep fallback active throughout backup/restore/rebuild.
- [x] Add residual scanning for every graph-derived artifact surface.
- [x] Bound retry, lease, process replacement, quarantine, and retained backup
      state.
- [x] Write inspect/disable/quarantine/delete/rebuild/verify/publish runbook.

### Focused verification

```bash
pnpm vitest run \
  tests/governance/graph-purge-propagation.test.ts \
  tests/governance/graph-correction.integration.test.ts \
  tests/recovery/graph-rebuild.test.ts \
  tests/recovery/graph-backup-restore.test.ts \
  tests/recovery/graph-outage.recovery.test.ts \
  tests/security/graph-content-residual.test.ts
pnpm test:governance
pnpm test:recovery
pnpm lint
pnpm typecheck
```

### Completion evidence

- [x] Zero resurrection, cross-scope change, or prohibited residual.
- [x] All outage/corruption/restore paths retain SQLite operation.
- [x] Runbook matches tested behavior.
- [x] Create the U6 commit.

U6 evidence recorded on 2026-07-29:

- The six-file focused suite passed 12/12 before the missing-database Oracle
  was added; the final graph outage plus graph recall regression passed 15/15.
- Governance passed 30/30; recovery passed 27/27.
- Full verification passed 58 files, 307 tests, with 1 platform skip.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed on Node 24.18.0.
- The dependency lock remained
  `sha256:4ecf84c7b6b15287f83c346a764742843ae795f099d61c1f34bbcad6864b6066`.
- U6 found and fixed two fail-closed gaps: exact-scope usage blocks now remove
  L1 graph nodes, and a missing/empty graph database can no longer turn a
  formerly ready checkpoint into a clean no-match because the graph snapshot
  is compared with the canonical SQLite digest before traversal.

**Rollback point:** disable graph lane/process and keep SQLite-only runtime.

## 9. U7 — Frozen paired replay and physical resource evidence

**Requirements:** R12, R19–R20; F3/F4;
M4A-AC3/M4A-AC5/M4A-AC8.

**Depends on:** U5; run after U6 for final evidence.

**Files:**

- `packages/graph-projection/src/benchmark.ts`
- `scripts/run-g4a-replay.mjs`
- `scripts/run-g4a-resource-benchmark.mjs`
- `scripts/run-g4a-baseline.mjs`
- `scripts/verify-g4a-evidence.mjs`
- `tests/replay/graph-multihop.test.ts`
- `tests/integration/graph-benchmark.integration.test.ts`
- `docs/evaluations/graph-scorecard.md`
- `.trellis/tasks/07-29-agent-memory-runtime-m4a/check.jsonl`

### Test-first checklist

- [x] Reject baseline arm unless its commit equals accepted G3R.
- [x] Reject B/C unless they share one candidate commit and lockfile.
- [x] Reject package/native/corpus/partition/policy/request/frontier/budget/
      threshold identity drift.
- [x] Prove calibration runner cannot open holdout/transfer payloads.
- [x] Prove all arms receive identical canonical SQLite input and limits.
- [x] Prove Arms B and C receive identical typed/shortest-path task semantics
      and governed slices; reject any comparison that withholds the reference
      algorithm from B.
- [x] Prove Arm B's runtime output outside the evaluation-only reference is
      semantically equal to accepted G3R.
- [x] Score exact revision set, ordered proof path, evidence, completeness, and
      abstention for each case.
- [x] Reject top-k/candidate count as task gain.
- [x] Reject ordering-only or latency-only differences as strict structural
      gain.
- [x] Require three strict gains including one holdout and one transfer.
- [x] Reject any case or partition regression.
- [x] Reject any governance, privacy, correction, purge, rebuild, recovery, or
      budget violation.
- [x] Reject missing Expected physical dataset or measurement.
- [x] Require at least 20 warm-ups and 100 measured query samples.
- [x] Measure graph-assisted p50/p95 and fallback p95.
- [x] Measure process startup/replacement and Expected full rebuild.
- [x] Measure graph database, WAL, export/backup, install delta, idle RSS, peak
      RSS, queue debt, and retained quarantine bytes.
- [x] Record Node, pnpm, OS, architecture, SQLite, LadybugDB, storage, native
      binary, compiler, transform, schema, sample, and warm-up identity.
- [x] Prove missing/failed/mixed report cannot be interpreted as GO.
- [x] Prove repeated evaluation produces the same logical scores and hashes.

### Implementation checklist

- [x] Implement exact accepted-baseline isolation.
- [x] Implement versioned A/B/C evaluation protocol.
- [x] Run Arm B through the evaluation-only graph-free structural reference
      and Arm C through LadybugDB over the identical governed slice.
- [x] Implement calibration/holdout/transfer access guard.
- [x] Implement structural scorer and strict-gain comparison.
- [x] Implement physical Expected profile materialization.
- [x] Implement latency, fallback, startup, rebuild, disk, install, RSS, and
      process-resource measurements.
- [x] Emit machine-readable reports plus human scorecard.
- [x] Implement independent evidence hash verifier.
- [x] Add root focused graph test/benchmark/verify scripts.

### Focused verification

```bash
pnpm test:graph
pnpm benchmark:graph
pnpm verify:g4a
pnpm test:g3r:h3
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] A/B/C identity and frozen-input checks pass.
- [x] Structural material-gain result is explicit.
- [x] Every hard safety/resource gate is explicit.
- [x] Reports distinguish measured Darwin arm64 evidence from declarations.
- [x] Create the U7 commit.

**Recorded U7 result (2026-07-29):** NO-GO. Structural strict gains were
0 with one transfer regression. The Expected logical profile was fully
materialized, but Expected native physical population and full rebuild were
not run after the structural gate failed; the verifier therefore forces the
resource gate to fail instead of extrapolating from Small evidence. Idle child
RSS also exceeded the frozen threshold.

**Rollback point:** evidence can conclude NO-GO without changing SQLite runtime.

## 10. U8 — Candidate freeze, full verification, and full-diff review

**Requirements:** R19–R20; F4; M4A-AC8/M4A-AC9.

**Depends on:** U6–U7.

**Files:**

- `docs/evaluations/g4a-code-review.md`
- `docs/evaluations/g4a-reproducibility-manifest.json`
- `scripts/verify-g4a-evidence.mjs`
- `.trellis/tasks/07-29-agent-memory-runtime-m4a/check.jsonl`

### Freeze checklist

- [ ] Record candidate commit before final evidence generation.
- [ ] Record dependency lock and every workspace package hash.
- [ ] Record package/native binary, Node, pnpm, OS, architecture, SQLite,
      storage schema, graph schema, compiler, transform, protocol, corpus,
      threshold, and environment identity.
- [ ] Record all focused and full command outputs as immutable artifacts or
      hash-bound reports.

### Full verification checklist

- [ ] Fresh frozen install under Node `24.18.0` and pnpm `10.33.2`.
- [ ] Frozen install with optional dependencies omitted builds and starts the
      SQLite-only MCP runtime.
- [ ] Production dependency audit has no unaccepted finding.
- [ ] Full build passes.
- [ ] Full lint passes.
- [ ] Full typecheck passes.
- [ ] Full repository test suite passes.
- [ ] All graph contract/storage/integration/governance/recovery/security/
      replay suites pass.
- [ ] Accepted G3R focused suite and evidence verification pass.
- [ ] SQLite-only startup and graph-disabled parity pass.
- [ ] Migration upgrade from every supported fixture passes.
- [ ] Structural and resource reports verify against frozen hashes.
- [ ] No untracked executable artifact influences results.
- [ ] `git diff --check`, JSON parsing, Markdown fences, and Trellis context
      validation pass.

### Full-diff review checklist

- [ ] Correctness review covers timeout, late response, epoch, digest, and
      clean-no-match failure scenarios.
- [ ] Architecture review confirms one-way authority and no package cycle.
- [ ] Security review covers IPC validation, process control, paths, logs,
      native identity, child environment, closed queries, restart storms, and
      content residual.
- [ ] Data-integrity review covers migration, leases, checkpoints, crash
      windows, restore, and purge.
- [ ] Reliability review covers startup, shutdown, kill, orphan, restart,
      lock, corruption, and fallback.
- [ ] Performance review covers query work, child churn, queue debt, disk, RSS,
      rebuild, and benchmark representativeness.
- [ ] Contract/API review covers lane/version compatibility and optional
      dependency behavior.
- [ ] Testing review maps every AC and hard gate to executable evidence.
- [ ] Project-standards review confirms Trellis, TypeScript, storage worker,
      diagnostics, and commit constraints.
- [ ] Resolve every P0/P1 before decision.
- [ ] If executable code changes, freeze a new candidate and regenerate all
      dependent evidence.

### Final verification

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:graph
pnpm test:g3r:h3
pnpm benchmark:graph
pnpm verify:g3r
pnpm verify:g4a
pnpm audit --prod
```

### Completion evidence

- [ ] One manifest binds all code, dependency, native, corpus, threshold,
      report, review, and environment identities.
- [ ] No unresolved P0/P1 remains.
- [ ] The first failing gate, if any, is unambiguous.
- [ ] Create the U8 evidence commit without executable changes.

**Rollback point:** graph remains default-off; decision may be NO-GO.

## 11. U9 — G4A decision, closure, and next-gate boundary

**Requirements:** R8, R19–R20; F4; M4A-AC2/M4A-AC8/M4A-AC9.

**Depends on:** U2 hard-stop failure or U8 complete evidence.

**Files:**

- `docs/evaluations/g4a-decision.md`
- `docs/adr/0003-local-graph-selection-gate.md`
- `docs/plans/2026-07-29-003-feat-local-graph-adoption-plan.md`
- `.trellis/tasks/07-29-agent-memory-runtime-m4a/task.json`
- `.trellis/tasks/07-29-agent-memory-runtime-m4a/check.jsonl`
- `.trellis/workspace/*/journal-*`

### Decision checklist

- [ ] Verify the decision references exactly one tested candidate/evidence
      identity or one U2 hard-stop identity.
- [ ] List qualification, implementation, structural, governance, recovery,
      resource, review, and artifact results separately.
- [ ] Record each threshold with measured value or explicit missing evidence.
- [ ] Record limitations, platform scope, unverified platforms, and synthetic
      evidence boundary.
- [ ] Record default policy and active SQLite fallback.
- [ ] Record graph database/process/package status after decision.

### GO branch

- [ ] Require all six hard-gate families to pass.
- [ ] Require material structural gain and no partition regression.
- [ ] Require zero critical correctness/governance/privacy failure.
- [ ] Require all Expected resource thresholds and full evidence.
- [ ] Require no unresolved P0/P1.
- [ ] Mark graph lane available only through explicit operator opt-in.
- [ ] Keep default runtime policy graph-disabled.
- [ ] Scope GO to the physically tested platform/environment.

### NO-GO branch

- [ ] Name the first failed hard gate and supporting artifact.
- [ ] Mark graph lane unavailable/disabled for Context.
- [ ] Preserve SQLite adjacency and accepted G3R behavior.
- [ ] Keep additive graph state inert or delete graph files safely.
- [ ] Avoid runtime auto-start or enabled native dependency.
- [ ] Record exact conditions required for future reevaluation.
- [ ] Mark NO-GO as completed M4A, not `HOLD` or unfinished work.

### Closure checklist

- [ ] Update ADR 0003 with the dated G4A result without erasing the original
      gate decision.
- [ ] Mark the unified plan and Trellis task completed with the decision.
- [ ] Run Trellis check and finish/archive workflow.
- [ ] Record journal summary, commits, tests, decision, limitations, and
      fallback.
- [ ] Create a scoped decision commit.
- [ ] Create separate archive and journal commits when those logical tasks
      complete.
- [ ] Do not push or create a pull request without explicit user permission.
- [ ] State that M4B is independent and may start its own
      brainstorm→research→plan→work flow.
- [ ] State that G4A does not authorize M5 or M6.

### Final closure verification

```bash
pnpm verify:g4a
git status --short
```

**Final outcome:** exactly one of `GO` or `NO-GO`, with SQLite authority and
default graph-disabled behavior in both cases.
