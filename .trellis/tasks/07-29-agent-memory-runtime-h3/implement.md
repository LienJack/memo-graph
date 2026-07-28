# Agent Memory Runtime H3 — Execution Checklist

## 1. Execution contract

This checklist implements H3 only. Product requirements retain their existing
R10, R11, R13–R15, R19–R20 identities. Work is test-first, ordered, and
committed once per completed unit.

Use Node `24.18.0` and pnpm `10.33.2` for every meaningful verification:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
```

### Commit policy

| Unit | Commit intent |
|---|---|
| U1 | `feat(contracts): define bounded recall contracts` |
| U2 | `feat(storage): persist scope projection frontiers` |
| U3 | `feat(storage): add bounded projection reads` |
| U4 | `feat(memory): revalidate exact projection lineage` |
| U5 | `feat(context): compile scope-keyed frontiers` |
| U6 | `feat(memory): expose relation truncation` |
| U7 | `test(g3): freeze bounded recall remediation` |
| U8 | `docs(g3): record bounded recall decision` |

Before each commit:

- run the focused tests listed for the unit;
- run lint/typecheck whenever a public or cross-package contract changes;
- run `git diff --check`;
- inspect staged paths and exclude unrelated user work.

## 2. Non-negotiable invariants

- SQLite L0/L1 is authoritative.
- Search completeness is explicit: clean `NO_MATCH` requires exhaustion.
- Projection return limit never silently becomes a storage-prefix limit.
- Every returned projection is validated against its exact source revision
  IDs and its exact scope frontier.
- A scope update cannot overwrite another scope's frontier.
- New multi-scope Context identity is independent of request scope order.
- V1 Context and receipt bytes remain replayable.
- Correction, usage block, revoke, tombstone, purge, and rebuild continue to
  suppress affected descendants.
- Any incomplete projection path preserves `recent_l1`.
- H3 does not enable projection lanes or downstream milestones before G3R.

## 3. U1 — Bounded recall contracts

**Requirements:** R10, R11, R13, R19–R20.

**Files:**

- `packages/contracts/src/projections.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/receipts.ts`
- `packages/contracts/src/replay.ts`
- `packages/contracts/src/index.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `tests/contract/projections.contract.test.ts`
- `tests/contract/mcp.contract.test.ts`
- `tests/contract/receipts.contract.test.ts`

**Test-first checklist:**

- [x] Add invalid tests for duplicate or unsorted V2 scope frontiers.
- [x] Add invalid tests for wrong aggregate hash, null scope hashes, and
      cross-entry ledger/tombstone mismatch.
- [x] Prove current scalar V1 frontier fixtures still parse unchanged.
- [x] Add policy tests proving request scan/batch caps can only narrow
      operator limits.
- [x] Add bounded-work telemetry tests for count invariants and mandatory
      reason codes on incomplete boundaries.
- [x] Add projection cursor tests for a valid stable key and malformed cursor.
- [x] Add exact-source result tests proving one result per requested ID and
      rejecting duplicate/missing results.
- [x] Add apply-batch tests requiring explicit principal and exact scope.
- [x] Export all new public types and canonical builders.

**Implementation checklist:**

- [x] Define `ContextFrontierV1Schema` as the current scalar schema.
- [x] Define `ContextScopeFrontierSchema` and
      `ContextFrontierV2Schema`.
- [x] Export `ContextFrontierSchema` as the V1/V2 union.
- [x] Implement canonical V2 sorting and aggregate-hash construction.
- [x] Add optional `bounded_work` to `LaneTelemetry` without defaulting old
      artifacts.
- [x] Add scan and source-batch policy limits plus narrowing semantics.
- [x] Add an operator-owned relation start cap; remove the hidden literal as
      the effective policy source.
- [x] Define projection page cursor/result completeness schemas.
- [x] Define exact source batch input/result and stable eligibility reasons.
- [x] Extend apply-batch input with `principal_id` and `scope`.
- [x] Keep all legacy Context/receipt contract fields backward compatible.

**Focused verification:**

```bash
pnpm vitest run \
  tests/contract/projections.contract.test.ts \
  tests/contract/mcp.contract.test.ts \
  tests/contract/receipts.contract.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] V1 compatibility, V2 invalid cases, and canonical hash cases pass.
- [x] Storage protocol rejects partial/ambiguous batch results.
- [x] Create the U1 commit.

**Rollback point:** revert only U1; no storage state exists yet.

## 4. U2 — Scope-keyed persisted projection frontier

**Requirements:** R14–R15, R19.

**Depends on:** U1.

**Files:**

- `migrations/0011-scope-projection-frontiers.sql`
- `packages/storage-sqlite/src/migrations.ts`
- `packages/storage-sqlite/src/projection-repository.ts`
- `packages/storage-sqlite/src/projection-effects.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/index.ts`
- `packages/memory-kernel/src/consolidation-service.ts`
- `tests/storage/data-root-and-migrations.integration.test.ts`
- `tests/storage/projection-schema.integration.test.ts`
- `tests/storage/projection-rebuild.integration.test.ts`
- `tests/governance/derived-invalidation.integration.test.ts`

**Test-first checklist:**

- [x] Prove migration `0011` applies after `0010` on empty and populated
      databases.
- [x] Prove the new primary key permits distinct rows for two exact scopes.
- [x] Prove scope A and scope B batches advance the global epoch while only
      updating their own scope row.
- [x] Prove an empty batch can advance the named scope frontier.
- [x] Reject mixed-principal, mixed-scope, or mismatched-retirement batches.
- [x] Prove global and scope projection epochs never move backward.
- [x] Prove governance mutation marks only the affected scope pending.
- [x] Prove rebuild establishes the same scope rows and hashes
      deterministically.

**Implementation checklist:**

- [x] Add `layered_projection_scope_state` and required exact lookup index.
- [x] Guard updates with `projection_write_guard`.
- [x] Preserve the global singleton as health/CAS state.
- [x] Add repository `scopeFrontier(principal, scope)` access.
- [x] Validate explicit command principal/scope before any mutation.
- [x] Upsert exact scope state in the existing immediate batch transaction.
- [x] Update projection effects for per-scope pending/unavailable state.
- [x] Make consolidation compare the requested scope frontier, not the global
      singleton, for no-op detection.
- [x] Keep old projections intact; missing verified scope state fails closed
      until consolidation/rebuild.
- [x] Runtime-decode all new client/worker responses.

**Focused verification:**

```bash
pnpm vitest run \
  tests/storage/data-root-and-migrations.integration.test.ts \
  tests/storage/projection-schema.integration.test.ts \
  tests/storage/projection-rebuild.integration.test.ts \
  tests/governance/derived-invalidation.integration.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] Scope B cannot overwrite scope A.
- [x] Existing migration history and M2 storage tests remain green.
- [x] Create the U2 commit.

**Rollback point:** code may ignore `0011`; the additive table remains safe.

## 5. U3 — Bounded projection paging

**Requirements:** R10–R11, R13.

**Depends on:** U2.

**Files:**

- `packages/storage-sqlite/src/projection-repository.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/memory-kernel/src/lane-retrievers.ts`
- `tests/storage/projection-schema.integration.test.ts`
- `tests/integration/layered-recall.integration.test.ts`

**Test-first checklist:**

- [x] Seed the only relevant projection after the first storage page and
      reproduce the pre-H3 false `NO_MATCH`.
- [x] Prove paging returns that projection before applying the return limit.
- [x] Prove cursor order is stable across projection types and IDs.
- [x] Prove a cursor cannot be reused for a different principal, scope, type
      filter, or frontier.
- [x] Prove a concurrent scope frontier change aborts/degrades the scan.
- [x] Prove clean `NO_MATCH` only when `exhausted=true`.
- [x] Prove scan ceiling returns retained matches plus
      `PROJECTION_SCAN_LIMIT`, counts, and degraded status.
- [x] Prove exact relation revision membership is filtered in storage before
      its return limit.

**Implementation checklist:**

- [x] Implement tuple cursor predicates and deterministic ordering.
- [x] Read page rows and scope frontier from one synchronous transaction.
- [x] Return exact total/examined/unexamined counts for the frozen page
      frontier.
- [x] Validate expected scope frontier on continuation pages.
- [x] Page generic projection lanes through the existing matcher.
- [x] Stop at return-limit+1, exhaustion, or operator scan ceiling.
- [x] Use exact relation revision IDs for relation projection lookup.
- [x] Populate `projection_scan` and `projection_return` bounded-work rows.
- [x] Remove limit-before-match and limit-before-membership paths.

**Focused verification:**

```bash
pnpm vitest run \
  tests/storage/projection-schema.integration.test.ts \
  tests/integration/layered-recall.integration.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] Late relevant row is returned or named degraded.
- [x] No incomplete scan emits clean `NO_MATCH`.
- [x] Create the U3 commit.

**Rollback point:** U2 scope state remains valid; projection lanes may be
disabled to return to M2 behavior.

## 6. U4 — Exact projection source revalidation

**Requirements:** R11, R13–R15.

**Depends on:** U2–U3.

**Files:**

- `packages/storage-sqlite/src/projection-repository.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/index.ts`
- `packages/memory-kernel/src/recall-orchestrator.ts`
- `tests/storage/projection-schema.integration.test.ts`
- `tests/integration/layered-recall.integration.test.ts`
- `tests/governance/derived-invalidation.integration.test.ts`

**Test-first checklist:**

- [x] Reproduce a valid projection whose source revision is beyond the first
      1,000 eligible L1 rows.
- [x] Prove exact-ID validation preserves that projection.
- [x] Add one test per stable missing/ineligible reason.
- [x] Prove correction, usage block, revoke, tombstone, and purge exclude the
      exact descendant on the next recall.
- [x] Prove another scope or unrelated descendant remains eligible.
- [x] Prove mixed L1/L2 source IDs are validated by their canonical table.
- [x] Prove all internal SQL chunks observe one ledger/tombstone snapshot.
- [x] Prove over-limit or incomplete batch degrades affected projection
      lanes and preserves `recent_l1`.

**Implementation checklist:**

- [x] Add one-snapshot exact source validation repository method.
- [x] Chunk SQL placeholders internally without leaving the read transaction.
- [x] Return exactly one ordered typed result per requested revision ID.
- [x] Replace `listProjectionSources(limit: 1_000)` in online recall.
- [x] Remove prefix-derived `sourceFrontierHash`.
- [x] Compare every persisted source envelope to its canonical result.
- [x] Use scope-state frontier for freshness and exact batch only for lineage.
- [x] Attribute exact-source exclusions and batch degradation to each lane.
- [x] Add `source_lineage_batch` bounded-work telemetry.

**Focused verification:**

```bash
pnpm vitest run \
  tests/storage/projection-schema.integration.test.ts \
  tests/integration/layered-recall.integration.test.ts \
  tests/governance/derived-invalidation.integration.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] No online correctness decision depends on a scope enumeration prefix.
- [x] Every returned projection has exact canonical lineage evidence.
- [x] Create the U4 commit.

**Rollback point:** disable projection lanes; M2 L1 recall remains available.

## 7. U5 — Scope-keyed Context compilation and replay

**Requirements:** R11, R13–R15, R19.

**Depends on:** U1–U4.

**Files:**

- `packages/context-compiler/src/hard-filters.ts`
- `packages/context-compiler/src/index.ts`
- `packages/context-compiler/src/receipt-builder.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/memory-kernel/src/recall-orchestrator.ts`
- `packages/mcp-server/src/index.ts`
- `tests/compiler/layered-context-compiler.test.ts`
- `tests/integration/frozen-layered-context-slice.integration.test.ts`
- `tests/integration/layered-runtime-regression.integration.test.ts`
- `tests/mcp/context-compiler.test.ts`
- `tests/replay/layered-context-replay.test.ts`

**Test-first checklist:**

- [x] Build two exact scopes with distinct verified frontiers and candidates.
- [x] Prove both candidates survive only against their own scope frontier.
- [x] Reject a candidate when its scope entry is absent or duplicated.
- [x] Prove scope request permutations yield one V2 aggregate, receipt hash,
      Context identity, and ordered item set.
- [x] Prove a second cross-scope epoch mismatch drops projection candidates
      and records safe degradation after exactly one retry.
- [x] Prove correction/tombstone in scope A changes only A eligibility and V2
      frontier entry.
- [x] Parse and replay V1 Context/receipt fixtures without adding V2 fields or
      changing hashes.
- [x] Prove projection lanes disabled remains semantically compatible with
      accepted M2.

**Implementation checklist:**

- [x] Build V2 frontiers from canonical scope order.
- [x] Retry the full scope recall set once on epoch mismatch.
- [x] Degrade safely when any scope frontier is missing/not ready.
- [x] Select candidate frontier by `scopeKey` in pure hard filters.
- [x] Bump layered compiler artifact version for V2.
- [x] Seal aggregate frontier and bounded-work telemetry into Context/receipt.
- [x] Preserve V1 parsing, hashing, stored lookup, and replay.
- [x] Keep MCP response status and fallback lane honest on degradation.

**Focused verification:**

```bash
pnpm vitest run \
  tests/compiler/layered-context-compiler.test.ts \
  tests/integration/frozen-layered-context-slice.integration.test.ts \
  tests/integration/layered-runtime-regression.integration.test.ts \
  tests/mcp/context-compiler.test.ts \
  tests/replay/layered-context-replay.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

**Completion evidence:**

- [x] Multi-scope frontiers are order independent and candidate local.
- [x] Old issued slices remain immutable and replayable.
- [x] Create the U5 commit.

**Rollback point:** keep V2 data stored but return to disabled projection
lanes and the accepted M2 compiler.

## 8. U6 — Relation truncation telemetry

**Requirements:** R10–R11, R13.

**Depends on:** U1, U3–U5.

**Files:**

- `packages/memory-kernel/src/lane-retrievers.ts`
- `packages/memory-kernel/src/recall-orchestrator.ts`
- `packages/storage-sqlite/src/relation-repository.ts`
- `tests/storage/relation-repository.integration.test.ts`
- `tests/integration/layered-recall.integration.test.ts`
- `tests/mcp/context-compiler.test.ts`

**Test-first checklist:**

- [x] Supply more distinct relation starts than the configured cap.
- [x] Prove deterministic retained prefix and exact dropped count.
- [x] Prove caller-side start truncation uses
      `RELATION_START_LIMIT`.
- [x] Prove repository fanout truncation uses
      `RELATION_FANOUT_LIMIT`.
- [x] Prove both reasons and bounded-work rows can coexist.
- [x] Prove the sealed receipt contains the same counts/reasons as lane
      telemetry.
- [x] Prove a truncated empty relation result is `DEGRADED`, not `NO_MATCH`.

**Implementation checklist:**

- [x] Replace literal `.slice(0, 100)` with
      `effective.limits.relation_max_starts`.
- [x] Measure distinct observed, retained, and truncated starts before
      traversal.
- [x] Preserve repository fanout truncation as a separate boundary.
- [x] Merge relation reasons without collapsing their semantics.
- [x] Propagate both boundaries through recall, compiler, MCP, and receipt.

**Focused verification:**

```bash
pnpm vitest run \
  tests/storage/relation-repository.integration.test.ts \
  tests/integration/layered-recall.integration.test.ts \
  tests/mcp/context-compiler.test.ts
pnpm lint
pnpm typecheck
```

**Completion evidence:**

- [x] No relation start disappears without typed receipt evidence.
- [x] Create the U6 commit.

**Rollback point:** projection lanes can be disabled; no canonical data
rollback is needed.

## 9. U7 — G3R frozen candidate and evaluation

**Requirements:** R20.

**Depends on:** U1–U6.

**Files:**

- `fixtures/g3/`
- `tests/replay/layered-context-replay.test.ts`
- `tests/replay/context-pollution.test.ts`
- `tests/replay/projection-ablation.test.ts`
- `tests/integration/layered-runtime-regression.integration.test.ts`
- `tests/integration/layered-benchmark.integration.test.ts`
- `packages/memory-kernel/src/layered-benchmark.ts`
- `packages/memory-kernel/src/layered-resource-benchmark.ts`
- `scripts/run-g3-benchmark.mjs`
- `scripts/run-g3-resource-benchmark.mjs`
- `docs/evaluations/`

**Checklist:**

- [x] Add immutable H3 regression cases referencing existing M0 case hashes.
- [x] Add late-match, scan-ceiling, >1,000-source, two-scope permutation,
      relation-start, exact governance, and V1 replay cases.
- [x] Freeze a new executable candidate commit after U6.
- [x] Run Arm A accepted M2 in its isolated checkout.
- [x] Run Arm B H3 binary with projection lanes disabled.
- [x] Run Arm C corrected layered compiler.
- [x] Run leave-one-lane-out diagnostics.
- [x] Rerun utility, pollution, governance, budget, rebuild, and partition
      assertions.
- [x] Generate Small and Expected resource reports at the corrected
      end-to-end boundary.
- [x] Bind executable, lockfile, fixture, report, environment, and source
      hashes in a new evidence manifest.
- [x] Do not modify old U7 reports or present compiler-only throughput as
      production capacity.

**Focused verification:**

```bash
pnpm test:g3
pnpm benchmark:g3
pnpm benchmark:g3:resources
```

**Completion evidence:**

- [x] Four review findings fail on the historical candidate and pass on H3.
- [x] Original G3 assertions and M2 parity pass.
- [x] Reports and hashes identify the new candidate.
- [x] Create the U7 commit.

**Rollback point:** record G3R `HOLD`; do not open downstream milestones.

## 10. U8 — Full verification and G3R decision

**Requirements:** R20.

**Depends on:** U7.

**Checklist:**

- [ ] Run full tests:

  ```bash
  pnpm test
  ```

- [ ] Run static checks:

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm build
  ```

- [ ] Verify dependency reproducibility and production audit in a clean
      temporary install:

  ```bash
  pnpm install --frozen-lockfile
  pnpm audit --prod
  ```

- [ ] Validate JSON, Markdown fences, evidence manifests, report/source
      hashes, and `git diff --check`.
- [ ] Run:

  ```bash
  python3 .trellis/scripts/task.py validate \
    07-29-agent-memory-runtime-h3
  ```

- [ ] Perform the mandatory full-diff correctness, maintainability, testing,
      project-standards, security, reliability, API-contract, data-integrity,
      performance, and simplicity review.
- [ ] Fix valid findings and rerun affected checks.
- [ ] Write a new explicit G3R `GO` or `HOLD` naming the tested executable
      commit and every gate result.
- [ ] Keep M4A, M4B, and M5 blocked unless the decision is `GO`.
- [ ] Update Product Contract/roadmap status without renumbering requirements
      or rewriting prior decisions.
- [ ] Create the U8 decision commit.

**GO conditions:**

- all four H3 Failure Oracles pass;
- original G3 and accepted M2 parity remain green;
- zero governance, privacy, budget, rebuild, or partition regression;
- resource evidence is bounded and honestly labeled;
- every artifact hash verifies;
- full review has no unresolved P0/P1 finding.

**HOLD conditions:**

- any incomplete search can still be `NO_MATCH`;
- exact source lineage is partial or not snapshot-consistent;
- a candidate can be compared with another scope's frontier;
- a cap remains silent in the receipt;
- V1 replay changes;
- any governance, purge, rebuild, M2 parity, or artifact-integrity gate fails.

## 11. Task closure

After U8:

1. update relevant Trellis specs only for durable new conventions;
2. record the session journal with decision, tests, and commit;
3. ensure the worktree contains no unrelated staged changes;
4. archive `07-29-agent-memory-runtime-h3`;
5. commit the archive move as its own completed task;
6. do not push or create a PR without explicit user authorization.
