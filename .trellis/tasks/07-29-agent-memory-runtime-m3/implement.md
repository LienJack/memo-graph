# Agent Memory Runtime M3 — Execution Checklist

## 1. Execution contract

This checklist implements M3 only. Product requirements retain their original
R4, R7–R15, R19–R20 identities. Complete units in order, keep tests
test-first, and create one scoped commit after each completed unit.

Use Node 24.18.0 and pnpm 10.33.2 for all meaningful validation.

### Commit policy

| Unit | Expected commit intent |
| --- | --- |
| U1 | `feat(contracts): define layered projection contracts` |
| U2 | `feat(storage): persist layered projections` |
| U3 | `feat(memory): govern projection lifecycle` |
| U4 | `feat(memory): add governed recall lanes` |
| U5 | `feat(context): compile layered context` |
| U6 | `feat(runtime): integrate layered context` |
| U7 | `test(g3): add layered context replay` |
| U8 | `docs(g3): record layered context decision` |

Before every commit:

- run the focused tests named by the unit;
- run `pnpm lint` and `pnpm typecheck` when a public contract changes;
- inspect `git diff --check` and staged paths;
- do not stage unrelated user changes.

## 2. Gate invariants

These are non-negotiable at every unit:

- SQLite L0/L1 remains authoritative.
- Derived state cannot widen scope/authority/validity or reduce sensitivity.
- Exact source revision lineage is mandatory.
- Canonical correction, demotion, usage block, revoke, purge, and tombstone
  exclude descendants from the next Context.
- No score may override a hard policy exclusion.
- Context never exceeds the requested token budget.
- Disabled/failed projection lanes degrade to the safe lower-layer behavior.
- Incremental state must equal a full rebuild at one frozen frontier.
- Frozen M0 replay files and hashes are never changed by M3.

## 3. U1 — Layered contracts

**Requirements:** R4, R7–R8, R10–R13, R19–R20; AE1–AE5.

**Files:**

- `packages/contracts/src/projections.ts`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/receipts.ts`
- `packages/contracts/src/tool-inputs.ts`
- `packages/contracts/src/replay.ts`
- `packages/contracts/src/index.ts`
- `tests/contract/projections.contract.test.ts`
- existing MCP/receipt contract tests

**Checklist:**

- [x] Write failing tests for valid Topic, Scenario/Procedure, Core, and
      Relation revisions.
- [x] Write invalid tests for missing/duplicate source revisions, malformed
      frontiers, widened scope, raised authority, reduced sensitivity, and
      invalid validity intersections.
- [x] Define projection type, revision envelope, typed payloads, exact lineage,
      transform, and frontier schemas.
- [x] Define stable lane identifiers, lane configuration, telemetry, named
      degradation, and inclusion/exclusion reasons.
- [x] Define operator-owned lane/resource ceilings and request overrides that
      can only narrow the effective configuration.
- [x] Extend Context item and receipt schemas with lane, projection,
      conflict/dedupe, score, token, frontier, and hash detail.
- [x] Add strict G3 overlay/rubric schemas referencing replay case hashes.
- [x] Preserve parsing of existing L0/L1 Context and receipt fixtures.
- [x] Export all public types from the package entrypoint.
- [x] Prove canonical serialization produces stable projection and receipt
      hashes.

**Focused verification:**

```bash
pnpm vitest run tests/contract/projections.contract.test.ts \
  tests/contract/mcp.contract.test.ts \
  tests/contract/receipts.contract.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] Happy, boundary, invalid, and compatibility contract tests pass.
- [x] No storage or runtime behavior was smuggled into the contract unit.
- [x] Create the U1 commit.

## 4. U2 — SQLite projection and relation model

**Requirements:** R4, R7–R8, R14–R15; AE2, AE4.

**Depends on:** U1.

**Files:**

- `migrations/0008-layered-projections.sql`
- `packages/storage-sqlite/src/projection-repository.ts`
- `packages/storage-sqlite/src/relation-repository.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/index.ts`
- `tests/storage/projection-schema.integration.test.ts`
- `tests/storage/relation-repository.integration.test.ts`
- `tests/storage/data-root-and-migrations.integration.test.ts`

**Checklist:**

- [x] Write migration tests before adding migration `0008`.
- [x] Add immutable projection object/revision and source-membership tables.
- [x] Add immutable relation object/revision tables.
- [x] Add projection frontier/rebuild receipt and outbox state.
- [x] Add indexes for exact scope/type/status, descendants, frontier, bounded
      traversal, and outbox claiming.
- [x] Add constraints against duplicate lineage and mutable revision payloads.
- [x] Implement repository claim/apply/fail/query/invalidate/rebuild
      operations with short transactions.
- [x] Runtime-decode every worker request and response payload.
- [x] Implement bounded directional SQLite adjacency queries.
- [x] Keep the SQLite driver private to `storage-sqlite`.
- [x] Confirm M1/M2 migrations and repository tests remain green.

**Focused verification:**

```bash
pnpm vitest run tests/storage/projection-schema.integration.test.ts \
  tests/storage/relation-repository.integration.test.ts \
  tests/storage/data-root-and-migrations.integration.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] Migration applies to empty and existing M2 databases.
- [x] Revisions and lineage are immutable and queryable.
- [x] Worker boundary rejects malformed operations.
- [x] Create the U2 commit.

## 5. U3 — Projection lifecycle and rebuild

**Requirements:** R7–R8, R14–R15; F1/F3; AE1, AE2, AE4.

**Depends on:** U2.

**Files:**

- `packages/memory-kernel/src/consolidation-service.ts`
- `packages/memory-kernel/src/projection-policy.ts`
- `migrations/0009-projection-purge-redaction.sql`
- existing mutation/admission/governance paths
- `tests/governance/derived-invalidation.integration.test.ts`
- `tests/storage/projection-rebuild.integration.test.ts`
- `tests/recovery/projection-outbox.recovery.test.ts`
- purge and delete integration tests

**Checklist:**

- [x] Write failing tests for deterministic Topic, Scenario/Procedure, Core,
      and Relation consolidation.
- [x] Derive projection identity from type, scope, sorted source revisions,
      transform, and normalized output.
- [x] Intersect source scope, authority, sensitivity, and validity without
      privilege amplification.
- [x] Enqueue refresh/invalidation with the canonical mutation transaction.
- [x] Re-read canonical sources after claiming a job and before applying it.
- [x] Make correction, demotion, usage block, revoke, tombstone, and purge
      synchronously suppress descendants.
- [x] Implement idempotent retry and content-free failure receipts.
- [x] Implement full rebuild from authoritative L0/L1 into an empty derived
      plane.
- [x] Compare incremental and rebuilt identities, hashes, lineage, relations,
      frontier, and order exactly.
- [x] Prove purge removes derived plaintext and rebuild cannot resurrect it.

**Focused verification:**

```bash
pnpm vitest run tests/governance/derived-invalidation.integration.test.ts \
  tests/storage/projection-rebuild.integration.test.ts \
  tests/recovery/projection-outbox.recovery.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] All lifecycle transitions and failure paths pass.
- [x] Full rebuild Oracle passes across correction and deletion fixtures.
- [x] Create the U3 commit.

## 6. U4 — Governed multi-lane recall

**Requirements:** R8, R10–R11, R14; F2/F3; AE2, AE3, AE5.

**Depends on:** U1–U3.

**Files:**

- `packages/memory-kernel/src/recall-orchestrator.ts`
- `packages/memory-kernel/src/lane-retrievers.ts`
- governed reader/query integration
- `tests/integration/layered-recall.integration.test.ts`
- `tests/governance/derived-invalidation.integration.test.ts`
- `tests/mcp/memory-kernel.integration.test.ts`

**Checklist:**

- [x] Add `recent_l1`, `topic`, `scenario_procedure`, `core`, and
      `relation_sqlite` lane adapters.
- [x] Authorize principal and exact scope before querying any lane.
- [x] Intersect requested lane/limit overrides with runtime policy so callers
      cannot self-enable or enlarge denied work.
- [x] Bound candidate counts and relation traversal depth/fan-out.
- [x] Batch-load all ancestor revisions and revalidate canonical status,
      validity, sensitivity, tombstone, lineage, and frontier.
- [x] Prevent scope crossover through relation intermediate nodes.
- [x] Record enabled, candidate, eligible, selected, exclusion, duration, and
      named degradation telemetry per lane.
- [x] Make one projection lane failure preserve safe `recent_l1` output.
- [x] Make all projection lanes disabled reproduce the M2 baseline.
- [x] Distinguish no match, policy exclusion, and lane degradation.

**Focused verification:**

```bash
pnpm vitest run tests/integration/layered-recall.integration.test.ts \
  tests/governance/derived-invalidation.integration.test.ts \
  tests/mcp/memory-kernel.integration.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] No stale or cross-scope projection reaches the compiler.
- [x] Lane telemetry is deterministic and content-free.
- [x] Create the U4 commit.

## 7. U5 — Pure layered Context Compiler

**Requirements:** R12–R13, R19; F2; AE1–AE3.

**Depends on:** U4.

**Files:**

- `packages/context-compiler/src/index.ts`
- `packages/context-compiler/src/hard-filters.ts`
- `packages/context-compiler/src/conflict-resolver.ts`
- `packages/context-compiler/src/ranking-policy.ts`
- `packages/context-compiler/src/token-packer.ts`
- `packages/context-compiler/src/receipt-builder.ts`
- `tests/compiler/layered-context-compiler.test.ts`
- `tests/compiler/token-packer.property.test.ts`
- `tests/mcp/context-compiler.test.ts`

**Checklist:**

- [x] Refactor the compiler into pure explicit stages without changing safe
      L0/L1 semantics.
- [x] Reject any candidate lacking a successful canonical-revalidation result.
- [x] Preserve competing claims as provenance-bearing conflict sets.
- [x] Dedupe repeated abstraction by exact lineage before budget packing.
- [x] Decompose deterministic scores into relevance, authority, freshness,
      diversity, conflict cost, token utility, and lane contribution.
- [x] Keep constraint, precondition, exception, failure, recovery, and policy
      items before redundant summaries.
- [x] Enforce hard global budgets for every integer from 1 through 32,000.
- [x] Use stable tie breaks and bounded lane minimums.
- [x] Record every inclusion, exclusion, and displacement reason.
- [x] Freeze compiler/lane/frontier/version/hash state into Context and receipt
      artifacts.
- [x] Return a valid immutable empty Context when no candidate is eligible.

**Focused verification:**

```bash
pnpm vitest run tests/compiler/layered-context-compiler.test.ts \
  tests/compiler/token-packer.property.test.ts \
  tests/mcp/context-compiler.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] Compiler has no I/O imports.
- [x] Property/boundary tests prove the hard budget.
- [x] Repeated calls with identical inputs seal identical artifacts.
- [x] Create the U5 commit.

## 8. U6 — Runtime, purge, restore, and MCP integration

**Requirements:** R8, R10–R15, R19; F2/F3; AE2, AE4, AE5.

**Depends on:** U3–U5.

**Files:**

- `packages/memory-kernel/src/index.ts`
- `packages/mcp-server/src/index.ts`
- storage worker/client integration
- purge, backup, restore, explain, and audit integration
- `tests/integration/frozen-layered-context-slice.integration.test.ts`
- `tests/recovery/stale-tombstone-restore.recovery.test.ts`
- `tests/recovery/purge-retry.recovery.test.ts`
- `tests/mcp/context-compiler.test.ts`

**Checklist:**

- [ ] Wire storage queries, lane orchestration, canonical revalidation, and the
      pure compiler through the kernel.
- [ ] Extend Context compile/search/explain/receipt MCP results with typed M3
      lane and frontier detail.
- [ ] Prove MCP lane configuration can only narrow operator policy.
- [ ] Preserve configured-principal authority; reject self-asserted request
      authority.
- [ ] Keep diagnostics content-free and degradation structured.
- [ ] Cover projection tables and payloads in purge/residual scans.
- [ ] Extend backup/restore so derived state is coherent or deterministically
      rebuilt.
- [ ] Preserve immutable historical Context slices after later mutations.
- [ ] Preserve the guarded purge exception: redact prohibited Context payload
      fields while retaining tombstone/hash/audit evidence and disabling exact
      replay.
- [ ] Verify the next compile reflects corrections, revoke, purge, and
      tombstone immediately.
- [ ] Prove projection failure does not break startup, mutation, delete, or
      lower-layer Context.

**Focused verification:**

```bash
pnpm vitest run tests/integration/frozen-layered-context-slice.integration.test.ts \
  tests/recovery/stale-tombstone-restore.recovery.test.ts \
  tests/recovery/purge-retry.recovery.test.ts \
  tests/mcp/context-compiler.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

**Completion evidence:**

- [ ] End-to-end MCP behavior returns explainable frozen artifacts.
- [ ] M0–M2 regression suite remains green.
- [ ] Create the U6 commit.

## 9. U7 — Frozen G3 three-arm replay

**Requirements:** R20; AE1–AE5.

**Depends on:** U6.

**Files:**

- `fixtures/g3/manifest.json`
- `fixtures/g3/overlays/*.json`
- `tests/helpers/g3-replay.ts`
- `tests/replay/layered-context-replay.test.ts`
- `tests/replay/context-pollution.test.ts`
- `tests/replay/projection-ablation.test.ts`
- `packages/memory-kernel/src/layered-benchmark.ts`
- `tests/integration/layered-runtime-regression.integration.test.ts`
- `docs/evaluations/g3-corpus.md`

**Checklist:**

- [ ] Reference every M0 case by immutable case ID and hash.
- [ ] Add projection seeds/transform inputs, required evidence units, task and
      pollution rubrics, lane configuration, and budgets only in the overlay.
- [ ] Keep calibration, holdout, and transfer partitions isolated.
- [ ] Implement Arm A accepted M2, Arm B M3 with projections disabled, and Arm
      C layered M3 on identical cases and budgets.
- [ ] Run Arm A from the exact G2-tested commit in an isolated checkout through
      the same versioned JSON evaluation protocol as B/C.
- [ ] Prove Arm B semantic compatibility with Arm A.
- [ ] Measure utility/evidence inclusion, context pollution, abstention,
      conflicts, governance, budgets, rebuild, and lane degradation.
- [ ] Add leave-one-lane-out diagnostics for attribution.
- [ ] Add the final Small/Expected benchmark and full-regression harness before
      freezing the U7 executable commit.
- [ ] Fail on any holdout leakage, corpus/hash mutation, governance violation,
      or budget overflow.

**Focused verification:**

```bash
pnpm test:fixtures
pnpm vitest run tests/replay/layered-context-replay.test.ts \
  tests/replay/context-pollution.test.ts \
  tests/replay/projection-ablation.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [ ] Frozen base manifest and case hashes are unchanged.
- [ ] Three-arm outputs and per-lane attribution are deterministic.
- [ ] Create the U7 commit.

## 10. U8 — Performance evidence and G3 decision

**Requirements:** R20; F2/F3; AE1–AE5.

**Depends on:** U7.

**Files:**

- `docs/evaluations/g3-replay-report.json`
- `docs/evaluations/g3-performance-report.json`
- `docs/evaluations/g3-decision.md`
- relevant reproducibility manifest

**Checklist:**

- [ ] Use the verified U7 commit as the frozen candidate implementation before
      running final evidence; U8 changes evidence/docs only.
- [ ] Record Node, pnpm, platform, dependency lock, schema, transform,
      projection, compiler, and fixture hashes.
- [ ] Run Small and Expected profiles with declared warm-up/sample counts.
- [ ] Measure compiler p50/p95, total request p50/p95, disk growth, projection
      rebuild cost, and token-budget adherence.
- [ ] Verify Small uses 10k evidence, 1k L1, 250 projections, and 1k relations.
- [ ] Verify Expected uses 250k evidence, 25k L1, 6k projections, and 50k
      relations.
- [ ] Verify compiler p50 is at most 100 ms and p95 at most 400 ms.
- [ ] Run the full contract, storage, governance, recovery, security,
      integration, compiler, and replay suites.
- [ ] Run lint, typecheck, build, frozen install, and dependency audit.
- [ ] Report every failed and quarantined case and all unresolved debt.
- [ ] Issue `GO` only if Arm C has zero governance/budget/rebuild violations,
      no aggregate/partition regression, and at least one strict designated
      improvement.
- [ ] Otherwise issue `HOLD` and preserve the accepted lower-layer fallback.

**Final verification:**

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm audit --audit-level=high
```

**Completion evidence:**

- [ ] Reports are hash-bound to the tested implementation commit.
- [ ] G3 decision is explicit, reproducible, and does not overclaim production
      readiness.
- [ ] Create the U8 commit.

## 11. G3 exit and closure

M3 is complete when:

- [ ] U1–U8 commits exist and each focused verification passed.
- [ ] The final full validation suite passes on Node 24.18.0.
- [ ] G3 is explicitly `GO` or `HOLD`.
- [ ] A `GO` authorizes M4A, M4B, and M5 as independent child tasks; it does
      not adopt graph, vector, or learning automatically.
- [ ] A `HOLD` preserves the M2 fallback and records the failed invariant or
      insufficient value.
- [ ] Trellis check and finish workflows pass.
- [ ] The child task is archived with the tested commit and journal evidence.
