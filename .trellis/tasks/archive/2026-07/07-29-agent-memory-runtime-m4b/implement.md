# Agent Memory Runtime M4B — Execution Checklist

## 1. Execution contract

This checklist implements M4B only. Product requirements retain R9–R14, R19,
and R20. Work is test-first, dependency ordered, and committed once per
completed logical unit.

Use Node `24.18.0` and pnpm `10.33.2` for every meaningful verification:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
```

### Commit policy

| Unit | Commit intent |
| --- | --- |
| U1 | `feat(vector): freeze adoption contracts and corpus` |
| U2 | `feat(vector): qualify isolated local candidate` |
| U3 | `feat(storage): persist vector delivery checkpoints` |
| U4 | `feat(vector): project and rebuild exact scopes` |
| U5 | `feat(memory): add governed semantic vector lane` |
| U6 | `test(vector): close governance and recovery oracles` |
| U7 | `test(vector): freeze G4B replay and resources` |
| U8 | `docs(vector): bind G4B verification evidence` |
| U9 | `docs(vector): record G4B decision` |

Before each commit:

- run focused tests for the unit;
- run lint, typecheck, and build for public/cross-package changes;
- run `git diff --check`;
- inspect staged paths and exclude unrelated user work;
- record the exact commit in the next dependent artifact.

### Hard-stop rule

U2 is the first mandatory gate. If any of these fail:

1. exact frozen dependency install and real model/index smoke;
2. `pnpm audit --audit-level high`;
3. build/start with optional dependencies omitted;
4. offline four-file snapshot/hash verification;
5. parent deadline, child quarantine/termination, and vector-free fallback;

mark U3–U8 skipped with evidence and proceed directly to U9 `NO-GO`.

Any later critical authority, scope, privacy, correction, purge, restore,
resurrection, fallback, M0 latency, artifact-integrity, or material-gain
failure also stops feature expansion and proceeds to the decision path.

## 2. Non-negotiable invariants

- SQLite owns identity, principal, scope, lifecycle, valid time, sensitivity,
  usage, conflict, evidence, tombstones, deletion receipts, projection
  frontiers, and Context receipts.
- Vector state stores only disposable revision identity, epoch/frontier/hash,
  and vector bytes—never rendered memory or evidence text.
- Runtime never downloads a model or sends text to a remote endpoint.
- The model snapshot is explicit, private, path-confined, and hash verified.
- Native embedding/index work never runs in the MCP process.
- Exact principal/scope maps to one isolated physical index membership set.
- Every semantic hit is postvalidated from current canonical SQLite.
- Similarity score never grants eligibility or counts as task success.
- Incomplete/stale vector work is degraded, not clean `NO_MATCH`.
- Correction and every exclusion control suppress the next read before
  physical convergence.
- Canonical mutation/delete/restore/recall never waits for vector work.
- Incremental and full rebuild produce the same canonical logical digest.
- Embedding epochs never mix and do not change canonical revision identity.
- Frozen holdout/transfer payloads remain evaluator-only until calibration
  configuration is sealed.
- Disabled/degraded behavior equals the accepted vector-free baseline.
- The lane remains disabled by default under both GO and NO-GO.
- M4A, M5, and M6 remain outside this task.

## 3. U1 — Freeze contracts and repository G4B fixtures

**Requirements:** R9–R13, R19–R20; F1/F2/F4;
M4B-AC1/M4B-AC4/M4B-AC8/M4B-AC9.

**Depends on:** None.

**Files:**

- `packages/contracts/src/vector.ts`
- `packages/contracts/src/projections.ts`
- `packages/contracts/src/replay.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/receipts.ts`
- `packages/contracts/src/index.ts`
- `fixtures/g4b/manifest.json`
- `fixtures/g4b/cases/*.json`
- `tests/contract/vector-index.contract.test.ts`
- `tests/contract/projections.contract.test.ts`
- `tests/contract/mcp.contract.test.ts`
- `tests/contract/receipts.contract.test.ts`
- `tests/fixtures/g4b-overlay.fixture.test.ts`

### Test-first checklist

- [ ] Decode a minimal immutable embedding epoch with exact runtime, model,
      four file hashes, dimensions, pooling, normalization, prefixes,
      tokenizer/truncation, index, metric, and schema identity.
- [ ] Reject missing, duplicate, unconfined, symlinked, non-regular, or
      hash-mismatched model files.
- [ ] Reject a remote URL or request-supplied model/path/epoch field.
- [ ] Decode exact-scope generation, vector record, query, result, health,
      checkpoint, job, and receipt fixtures.
- [ ] Reject vector records containing memory/query/evidence text, approval,
      ACL, sensitivity bodies, or deletion receipts.
- [ ] Reject wrong dimension, non-finite value, mixed epoch, mixed generation,
      mismatched scope/frontier/hash, duplicate revision, and unbounded top-k.
- [ ] Prove reordered logical records normalize to the same digest.
- [ ] Prove revision/vector/epoch/prefix/scope/frontier change changes digest.
- [ ] Add `semantic_vector` lane and every exhaustive lane mapping.
- [ ] Prove vector remains absent from default operator/request policy.
- [ ] Add vector bounded-work categories for embed inputs/tokens/batches,
      candidates, postvalidations, process, and fallback.
- [ ] Reject count inconsistencies and incomplete work without stable reason.
- [ ] Prove old G3R/G4A requests, Contexts, receipts, and hashes are unchanged.
- [ ] Translate all nine frozen cases without changing any query, candidate,
      lifecycle, scope, time, expected ID, partition, budget, arm, or threshold.
- [ ] Prove candidate details were absent at freeze and baseline/freeze hashes
      match the committed declaration.
- [ ] Prove ordinary implementation code cannot read holdout/transfer payloads.

### Implementation checklist

- [ ] Define backend-neutral vector/epoch/process/delivery/replay schemas.
- [ ] Build deterministic epoch and logical-vector digest helpers.
- [ ] Add optional/versioned lane fields through policy, Context, receipt, MCP,
      and replay schemas.
- [ ] Create immutable G4B manifest and case files.
- [ ] Export all new public schemas, builders, and types.
- [ ] Preserve strict decoder behavior and backward compatibility.

### Focused verification

```bash
pnpm vitest run \
  tests/contract/vector-index.contract.test.ts \
  tests/contract/projections.contract.test.ts \
  tests/contract/mcp.contract.test.ts \
  tests/contract/receipts.contract.test.ts \
  tests/fixtures/g4b-overlay.fixture.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Invalid/boundary fixtures fail for the intended reason.
- [ ] Existing artifact compatibility is exact.
- [ ] G4B corpus, threshold, and epoch-contract hashes are recorded.
- [ ] Create the U1 commit.

**Rollback point:** revert U1; no dependency, migration, or vector state exists.

## 4. U2 — Optional dependency and process-isolation hard gate

**Requirements:** R9–R10, R13, R19–R20; F1/F2/F4;
M4B-AC2/M4B-AC3/M4B-AC7/M4B-AC9.

**Depends on:** U1.

**Files:**

- `packages/vector-retrieval/package.json`
- `packages/vector-retrieval/tsconfig.json`
- `packages/vector-retrieval/src/embedder.ts`
- `packages/vector-retrieval/src/local-model.ts`
- `packages/vector-retrieval/src/vector-index.ts`
- `packages/vector-retrieval/src/protocol.ts`
- `packages/vector-retrieval/src/path-security.ts`
- `packages/vector-retrieval/src/process-host.ts`
- `packages/vector-retrieval/src/vector-process.ts`
- `packages/vector-retrieval/src/logical-digest.ts`
- `packages/vector-retrieval/src/index.ts`
- `package.json`
- `pnpm-lock.yaml`
- `tests/contract/vector-index.contract.test.ts`
- `tests/recovery/vector-process.recovery.test.ts`
- `tests/security/vector-process-protocol.test.ts`
- `tests/integration/vector-dependency.integration.test.ts`

### Test-first checklist

- [ ] Prove package top-level import with optional dependencies absent.
- [ ] Prove frozen install with optional dependencies omitted, build, and
      SQLite-only MCP startup.
- [ ] Reject package, extension, platform, architecture, model, revision,
      file, dimensions, pooling, normalization, or prefix mismatch.
- [ ] Prove a valid child reports the complete expected identity.
- [ ] Reject an incomplete provider cache even when some hashes happen to
      exist.
- [ ] Prove remote model access remains disabled during real model load/use.
- [ ] Reject oversized, malformed, unknown-version, unknown-operation,
      duplicate-ID, late, or mismatched IPC messages.
- [ ] Reject caller-controlled file paths, SQL, model IDs, URLs, environment,
      and index names.
- [ ] Reject paths outside the data/model roots and symlink substitution.
- [ ] Prove the child environment excludes unrelated parent secrets.
- [ ] Prove only a closed operation set reaches the adapter.
- [ ] Prove one child owns its opened vector database handles.
- [ ] Prove insert/search/delete/replace/snapshot/close/reopen with the injected
      deterministic adapter.
- [ ] Prove explicit transaction rollback leaves the prior logical digest.
- [ ] Prove the real pinned snapshot emits a normalized 384-dimensional vector.
- [ ] Prove sqlite-vec v0.1.9 flat cosine search/delete/reopen.
- [ ] Start a stuck operation and prove parent deadline returns typed fallback.
- [ ] Measure at least 100 timeout/fallback samples and require p95 <=100 ms.
- [ ] Kill the child during query and uncommitted write; parent remains
      responsive and reopen sees only committed state.
- [ ] Prove duplicate/late/post-timeout response cannot satisfy another call.
- [ ] Prove replacement starts outside the failed request and repeated failures
      activate restart rate limiting/cooldown.
- [ ] Prove shutdown leaves no child, timer, or file handle leak.
- [ ] Prove stdout/stderr/logs contain no query or passage content.
- [ ] Prove a child failure cannot close or corrupt canonical SQLite.
- [ ] Prove exact versions plus `adm-zip@0.6.0` and `sharp@0.35.3` pass the
      repository high-severity audit.
- [ ] Prove the vector package explicitly resolves the existing exact
      `better-sqlite3@13.0.1` binding and does not depend on workspace hoisting
      or install a conflicting native copy.

### Implementation checklist

- [ ] Create workspace package after contracts and before MCP composition.
- [ ] Pin candidate dependencies and approved overrides in the lockfile.
- [ ] Declare native/model runtime dependencies optional.
- [ ] Dynamically import Transformers.js and sqlite-vec only inside the child.
- [ ] Implement exact four-file verifier and immutable epoch identity.
- [ ] Implement injectable deterministic embedder/index ports.
- [ ] Implement closed, runtime-decoded, bounded IPC.
- [ ] Derive/confine data/model paths and allowlist child environment.
- [ ] Implement request identity, deadline, response matching, quarantine,
      OS termination, non-blocking replacement, restart rate limit, and
      cooldown.
- [ ] Implement content-free stable failures and cleanup.
- [ ] Keep vector absent from default runtime configuration.

### Focused verification

```bash
pnpm vitest run \
  tests/contract/vector-index.contract.test.ts \
  tests/recovery/vector-process.recovery.test.ts \
  tests/security/vector-process-protocol.test.ts \
  tests/integration/vector-dependency.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
pnpm audit --audit-level high
```

Also run the frozen-install/no-optional and real local-model smoke evidence
declared by the gate harness.

### Completion evidence

- [ ] Dependency, override, lockfile, model-file, extension, binary, platform,
      and environment identities are recorded.
- [ ] Offline ready, embed/search/delete/reopen, deadline/fallback, and
      kill/recovery pass.
- [ ] Frozen install and audit pass.
- [ ] Decide whether U3 is permitted or U9 NO-GO starts.
- [ ] Create the U2 commit when permitted.

**Rollback point:** remove/disable the optional package; canonical runtime is
unchanged.

## 5. U3 — SQLite epoch, outbox, and scope checkpoint state

**Requirements:** R9–R10, R13–R14, R19; F2/F3;
M4B-AC3/M4B-AC5/M4B-AC6/M4B-AC7.

**Depends on:** U2 hard gate passes.

**Files:**

- `migrations/0013-vector-projection-delivery.sql`
- `packages/storage-sqlite/src/vector-projection-repository.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/projection-effects.ts`
- `packages/storage-sqlite/src/governance-repository.ts`
- `packages/storage-sqlite/src/purge-repository.ts`
- `packages/storage-sqlite/src/restore.ts`
- `packages/storage-sqlite/src/index.ts`
- `tests/integration/vector-projection.integration.test.ts`
- `tests/governance/vector-correction.integration.test.ts`
- `tests/governance/vector-purge-propagation.test.ts`
- `tests/recovery/vector-outbox.recovery.test.ts`

### Test-first checklist

- [ ] Upgrade a current database and prove all canonical hashes/counts remain.
- [ ] Register one immutable epoch and reject identity collision or mutation.
- [ ] Enforce at most one active configured epoch.
- [ ] Create exact-scope checkpoint with desired/active
      epoch/generation/frontier/digest and legal state transitions.
- [ ] Reject cross-principal/scope, stale frontier, wrong epoch/generation,
      invalid digest, or backward publication.
- [ ] Enqueue/coalesce one content-free scope job per canonical effect.
- [ ] Prove vector-disabled ordinary mutation enqueues no maintenance.
- [ ] Prove enabling evaluation schedules a full current-state rebuild.
- [ ] Claim, renew, apply, fail, retry, release, and recover leases.
- [ ] Prove duplicate delivery is idempotent.
- [ ] Prove canonical mutation and vector pending/invalidation commit together.
- [ ] Prove vector failure cannot roll back canonical mutation.
- [ ] Expose governed exact-scope source listing and batch eligibility through
      decoded worker messages.
- [ ] Reject unknown/malformed worker request or response.
- [ ] Prove correction/revoke/block/tombstone advances canonical truth before
      vector delivery.
- [ ] Prove backup/restore never moves behind current tombstone/publication
      frontier.
- [ ] Record content-free apply/failure/rebuild/purge receipts.
- [ ] Store the next source validity transition and mark/enqueue an affected
      scope through a bounded temporal sweep when time crosses it.
- [ ] Prove a time-stale scope degrades until rebuilt rather than returning a
      clean vector miss.

### Implementation checklist

- [ ] Add additive migration with constraints, indexes, and foreign keys.
- [ ] Implement epoch registry and exact-scope checkpoint repository.
- [ ] Implement lease-based content-free outbox.
- [ ] Integrate vector effects into canonical mutation transactions only while
      evaluating/enabled.
- [ ] Expose governed source and batch revalidation operations.
- [ ] Integrate purge, restore, backup, rebuild, and health metadata.
- [ ] Extend storage protocol/worker/client with strict decoders.
- [ ] Export the public vector-delivery repository surface.

### Focused verification

```bash
pnpm vitest run \
  tests/integration/vector-projection.integration.test.ts \
  tests/governance/vector-correction.integration.test.ts \
  tests/governance/vector-purge-propagation.test.ts \
  tests/recovery/vector-outbox.recovery.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Migration upgrade/reopen and invariant tests pass.
- [ ] Mutation/outbox coupling and vector-disabled no-work behavior pass.
- [ ] Restore/frontier and content-free receipts pass.
- [ ] Create the U3 commit.

**Rollback point:** disable vector, drain leases, retain canonical state, and
drop only additive derived-state metadata after evidence capture.

## 6. U4 — Exact-scope projection, epoch publication, purge, and rebuild

**Requirements:** R9–R10, R13–R14, R19; F2/F3;
M4B-AC3/M4B-AC5/M4B-AC6/M4B-AC7.

**Depends on:** U3.

**Files:**

- `packages/vector-retrieval/src/projector.ts`
- `packages/vector-retrieval/src/rebuilder.ts`
- `packages/vector-retrieval/src/vector-index.ts`
- `packages/vector-retrieval/src/process-host.ts`
- `packages/vector-retrieval/src/logical-digest.ts`
- `tests/integration/vector-projection.integration.test.ts`
- `tests/recovery/vector-rebuild.test.ts`
- `tests/governance/vector-purge-propagation.test.ts`
- `tests/security/vector-content-residual.test.ts`

### Test-first checklist

- [ ] Derive one physical path from principal/exact-scope digest and reject
      caller path input, escape, or symlink.
- [ ] Claim scope work and record starting canonical/frontier identity.
- [ ] List only current canonically eligible exact-scope sources.
- [ ] Exclude every `sensitive` and `secret` source from vector projection
      membership even when a caller may use sensitive vector-free recall.
- [ ] Embed fixed-prefix passages in bounded batches.
- [ ] Persist only revision/epoch/frontier/hash/vector fields.
- [ ] Build in quarantine and prove it is never queryable.
- [ ] Publish only when ending frontiers and source-set digest equal start.
- [ ] Reject publication after concurrent canonical mutation.
- [ ] Coalesce replacement work after rejected stale build.
- [ ] Replace one scope without touching another.
- [ ] Publish empty scope and remove the prior active generation.
- [ ] Prove incremental replacement and full rebuild logical digest equality.
- [ ] Prove physical database hashes may differ without affecting logical
      equality.
- [ ] Build a new epoch beside the old; never mix records or query epochs.
- [ ] Publish a complete new epoch atomically and retire the old.
- [ ] Kill/fail/timeout during build and prove quarantine remains inactive.
- [ ] Corrupt/lock/remove active file and prove typed rebuild/fallback.
- [ ] Purge old revision/vector bytes from active, quarantine, WAL, sidecar,
      temp, and backup-projection paths.
- [ ] Prove unrelated scope/model snapshot remains.
- [ ] Prove logs/errors/receipts contain no raw passage.
- [ ] Record exact content-free build/rebuild/publish/purge receipts.

### Implementation checklist

- [ ] Implement bounded exact-scope projector.
- [ ] Implement quarantine generation and frontier/digest compare-and-publish.
- [ ] Implement incremental replacement and full rebuild coordinator.
- [ ] Implement epoch migration and atomic activation.
- [ ] Implement physical cleanup and residual verification.
- [ ] Implement stale/corrupt/locked recovery.
- [ ] Implement idempotent job outcome reporting.
- [ ] Ensure every file handle and transient path closes/cleans on success or
      failure.

### Focused verification

```bash
pnpm vitest run \
  tests/integration/vector-projection.integration.test.ts \
  tests/recovery/vector-rebuild.test.ts \
  tests/governance/vector-purge-propagation.test.ts \
  tests/security/vector-content-residual.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Incremental/full rebuild and epoch isolation pass.
- [ ] Concurrent mutation, crash, corruption, and lock never publish stale
      state.
- [ ] Purge residual scan and unrelated-scope isolation pass.
- [ ] Create the U4 commit.

**Rollback point:** disable projection, delete disposable vector generations,
and rebuild later from canonical state.

## 7. U5 — Governed `semantic_vector` recall and Context integration

**Requirements:** R9–R13, R19–R20; F2;
M4B-AC3/M4B-AC4/M4B-AC7/M4B-AC8.

**Depends on:** U4.

**Files:**

- `packages/vector-retrieval/src/retriever.ts`
- `packages/vector-retrieval/src/index.ts`
- `packages/memory-kernel/src/lane-retrievers.ts`
- `packages/memory-kernel/src/recall-orchestrator.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/context-compiler/src/hard-filters.ts`
- `packages/context-compiler/src/ranking-policy.ts`
- `packages/context-compiler/src/receipt-builder.ts`
- `packages/context-compiler/src/index.ts`
- `packages/mcp-server/src/index.ts`
- `packages/mcp-server/package.json`
- `package.json`
- `tests/integration/vector-recall.integration.test.ts`
- `tests/mcp/memory-kernel.integration.test.ts`
- `tests/mcp/context-compiler.test.ts`
- `tests/compiler/layered-context-compiler.test.ts`

### Test-first checklist

- [ ] Prove default MCP/kernel policy never schedules vector work.
- [ ] Prove operator/request intersection can only narrow vector limits.
- [ ] Reject request-supplied path, model, epoch, remote URL, dimension,
      metric, or cross-scope filter.
- [ ] Query only current published exact-scope epoch/generation.
- [ ] Enforce top-k, payload, deadline, and bounded-work counts.
- [ ] Return revision IDs/distance/rank/epoch/frontier without memory content.
- [ ] Batch reread every vector hit from canonical SQLite.
- [ ] Extend memory-candidate unions so `semantic_vector` carries governed L1
      memory and cannot be misclassified as a projection lane.
- [ ] Reject wrong principal/scope, changed source hash, stale frontier,
      lifecycle, validity, sensitivity, usage, conflict, tombstone, or lineage.
- [ ] Treat all-stale hits as degraded, not clean no-match.
- [ ] Materialize accepted content/provenance only from canonical rows.
- [ ] Deduplicate semantic/base candidate identity without double token cost.
- [ ] Preserve conflict/complementarity/ordering/budget behavior.
- [ ] Seal stable content-free lane status and telemetry into Context/receipt.
- [ ] Prove disabled, model-missing, dependency-missing, stale, rebuilding,
      locked, corrupt, or timed-out state returns exact vector-free output.
- [ ] Prove a real current complete empty result is clean `NO_MATCH`.
- [ ] Prove legacy MCP request/response/receipt compatibility.
- [ ] Prove SQLite-only startup without optional dependency or model.

### Implementation checklist

- [ ] Implement backend-neutral semantic retriever.
- [ ] Compose optional vector package only at MCP configuration boundary.
- [ ] Add semantic lane scheduling, timeout, and typed degradation.
- [ ] Add canonical batch postvalidation and candidate materialization.
- [ ] Integrate optional telemetry without changing compiler authority.
- [ ] Keep every default and vector-disabled code path unchanged.
- [ ] Close child and projection resources during MCP shutdown.

### Focused verification

```bash
pnpm vitest run \
  tests/integration/vector-recall.integration.test.ts \
  tests/mcp/memory-kernel.integration.test.ts \
  tests/mcp/context-compiler.test.ts \
  tests/compiler/layered-context-compiler.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Exact-scope semantic recall passes with canonical postvalidation.
- [ ] Disabled/degraded vector-free equality and compatibility pass.
- [ ] Telemetry/receipts are bounded and content-free.
- [ ] Create the U5 commit.

**Rollback point:** remove `semantic_vector` from operator configuration; all
canonical and accepted lane behavior remains.

## 8. U6 — Governance, privacy, purge, and recovery hard gates

**Requirements:** R10–R14, R19–R20; F2/F3/F4;
M4B-AC4/M4B-AC5/M4B-AC6/M4B-AC7/M4B-AC9.

**Depends on:** U5.

**Files:**

- `tests/governance/vector-correction.integration.test.ts`
- `tests/governance/vector-purge-propagation.test.ts`
- `tests/recovery/vector-rebuild.test.ts`
- `tests/recovery/vector-outage.recovery.test.ts`
- `tests/security/vector-content-residual.test.ts`
- `tests/security/vector-scope-isolation.test.ts`
- relevant minimal fixes in vector/storage/kernel packages.

### Test-first checklist

- [ ] Correct/replace a revision while its old vector remains; next recall
      excludes old and may include canonical successor.
- [ ] Pin preserves eligible retrieval without granting extra scope.
- [ ] Demote and explicit Context block suppress the next recall.
- [ ] Revoke, usage block, conflict, expiry, tombstone, and purge suppress the
      next recall before physical convergence.
- [ ] Wrong principal/scope vector injected adversarially never enters Context
      or reveals membership in telemetry.
- [ ] Sensitive/secret row without required permission never enters embedding,
      index, receipt, telemetry, or Context.
- [ ] Sensitive/secret rows never enter vector membership at all; authorized
      sensitive recall continues through the vector-free lanes.
- [ ] Purge removes active/quarantine/WAL/sidecar/temp/backup-projection
      identity and vector bytes while unrelated scope remains.
- [ ] Model input and query text are absent from database, filesystem, logs,
      errors, receipts, and artifacts.
- [ ] Missing/corrupt/locked/stale/rebuilding index preserves vector-free
      recall and canonical mutation/delete/restore.
- [ ] Query timeout and child crash preserve vector-free fallback p95 <=100 ms.
- [ ] Kill during write cannot publish partial state.
- [ ] Repeated child failure cannot create process/timer/CPU storm.
- [ ] Full rebuild after total vector deletion equals incremental digest.
- [ ] Epoch migration interruption leaves exactly one old complete epoch
      active; resume publishes exactly one new complete epoch.
- [ ] Restore an old canonical/vector backup and prove tombstone frontier
      prevents resurrection.
- [ ] Reopen after crash and prove queue/lease/checkpoint recovery is
      idempotent and monotonic.
- [ ] Validate receipt and health states for every injected failure.

### Implementation checklist

- [ ] Harden only code paths exposed by failing adversarial tests.
- [ ] Preserve immediate canonical suppression and asynchronous convergence.
- [ ] Preserve exact-scope isolation in storage, filesystem, IPC, telemetry,
      and receipts.
- [ ] Ensure cleanup is idempotent and bounded.
- [ ] Keep fallback and canonical operations independent of recovery.
- [ ] Capture the first hard failure without masking it through retry.

### Focused verification

```bash
pnpm vitest run \
  tests/governance/vector-correction.integration.test.ts \
  tests/governance/vector-purge-propagation.test.ts \
  tests/recovery/vector-rebuild.test.ts \
  tests/recovery/vector-outage.recovery.test.ts \
  tests/security/vector-content-residual.test.ts \
  tests/security/vector-scope-isolation.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Zero critical authority/scope/privacy/correction/purge/restore/
      resurrection/fallback regressions.
- [ ] Every incomplete state is typed degradation.
- [ ] Decide whether U7 is permitted or U9 NO-GO starts.
- [ ] Create the U6 commit when permitted.

**Rollback point:** disable/delete disposable vector state; canonical controls
already provide the immediate safety boundary.

## 9. U7 — Frozen four-arm replay and expected-profile resource gate

**Requirements:** R9–R13, R19–R20; F1/F2/F4;
M4B-AC1/M4B-AC8/M4B-AC9.

**Depends on:** U6 hard gates pass.

**Files:**

- `tests/helpers/g4b-replay.ts`
- `tests/replay/vector-semantic-gap.test.ts`
- `tests/integration/vector-benchmark.integration.test.ts`
- `scripts/run-g4b-replay.mjs`
- `scripts/run-g4b-resource-benchmark.mjs`
- `docs/evaluations/g4b-replay-report.json`
- `docs/evaluations/g4b-resource-report.json`
- `docs/evaluations/vector-scorecard.md`

### Test-first checklist

- [x] Load all nine case hashes and reject drift.
- [x] Run calibration only and freeze top-k/threshold/fusion configuration.
- [x] Seal calibration configuration before evaluator opens holdout/transfer.
- [x] Reject an implementation/tuning process that reads evaluation payloads.
- [x] Create identical canonical setup for all four arms.
- [x] Prove same reader, as-of time, permissions, filters, Context Compiler,
      budgets, and task scoring in every arm.
- [x] Run both token budgets for every case.
- [x] Score expected live revisions and exact negative exclusions.
- [x] Score provenance/explanation and task Oracle.
- [x] Measure duplicates, contradictions, distractors, token use, and Context
      pollution.
- [x] Credit strict gain only when hybrid completely passes and both
      vector-free arms fail under identical limits.
- [x] Require hybrid positive success >=5/6.
- [x] Require strict gains >=4 including holdout and transfer.
- [x] Require zero negative-control/critical regression and no pollution
      increase.
- [x] Generate M0 expected profile deterministically.
- [x] Measure recall/context/fallback p50/p95/p99.
- [x] Require recall <=50/200 ms p50/p95.
- [x] Require Context <=100/400 ms p50/p95.
- [x] Require fallback p95 <=100 ms.
- [x] Measure cold ready, scope/full rebuild, epoch migration, install/model/
      index/WAL/temp bytes, disk growth, and idle/peak RSS.
- [x] Report all costs even if a hard gate already fails.
- [x] Repeat and require deterministic case outcomes and bounded measurement
      variation.

### Implementation checklist

- [x] Create gated corpus loader with calibration/evaluator capabilities.
- [x] Implement four accepted runtime arms without alternate readers.
- [x] Implement paired case/task/pollution scorer.
- [x] Implement deterministic M0 profile generator.
- [x] Implement real-candidate latency/resource harness.
- [x] Emit schema-validated hash-bound reports and human scorecard.
- [x] Record the first failed hard gate and all subsequent observed costs.

### Focused verification

```bash
pnpm vitest run \
  tests/replay/vector-semantic-gap.test.ts \
  tests/integration/vector-benchmark.integration.test.ts
pnpm run g4b:replay
pnpm run g4b:resources
```

### Completion evidence

- [x] Calibration receipt and evaluation isolation pass.
- [x] Four-arm utility/pollution thresholds are mechanically evaluated.
- [x] M0 latency and all material resource costs are recorded.
- [x] Decide whether G4B is eligible for GO or forced NO-GO.
- [x] Create the U7 commit.

**Rollback point:** reports remain immutable; vector runtime stays disabled
until U9.

## 10. U8 — Reproducibility, audit, documentation, and review

**Requirements:** R19–R20; F4; M4B-AC8/M4B-AC9.

**Depends on:** U7 or first hard-stop evidence.

**Files:**

- `scripts/verify-g4b-evidence.mjs`
- `docs/evaluations/g4b-verification-report.json`
- `docs/evaluations/g4b-reproducibility-manifest.json`
- `docs/runbooks/vector-rebuild.md`
- `docs/adr/0004-local-vector-adoption.md`
- `package.json`
- `tests/integration/g4b-artifact-integrity.test.ts`

### Evidence checklist

- [x] Bind accepted baseline commit and lock hash.
- [x] Bind tested candidate implementation commit.
- [x] Bind dirty-state policy and changed-path digest.
- [x] Bind Node/pnpm/OS/architecture and relevant environment.
- [x] Bind exact direct/transitive dependency and override identities.
- [x] Bind high-severity audit output and frozen-install outcomes.
- [x] Bind model repository/revision and all four file hashes/sizes.
- [x] Bind embedding epoch and active generation identity.
- [x] Bind corpus, partition, calibration configuration, thresholds, and
      evaluator capability hashes.
- [x] Bind replay and resource report hashes.
- [x] Bind focused/full test, lint, typecheck, build, no-optional startup, and
      artifact-verifier results.
- [x] Bind governance/privacy/purge/recovery/fallback outcomes.
- [x] Bind scorecard, review, limitations, platform boundary, and active
      fallback.
- [x] Record commands as data without embedding user secrets or model content.
- [x] Verify cross-artifact identity/reference/hash consistency.
- [x] Reject GO when any hard rule is false or evidence is missing.
- [x] Reject a second candidate or post-holdout calibration change.

### Documentation checklist

- [x] Document private local model materialization and verification.
- [x] Document no-network runtime and optional-dependency behavior.
- [x] Document vector modes, health, typed degradation, and fallback.
- [x] Document exact-scope path/privacy boundary without exposing clear scope
      in filenames.
- [x] Document rebuild, epoch migration, corruption, outage, purge, restore,
      disable, and rollback.
- [x] State process containment is not an OS sandbox.
- [x] State Darwin arm64/Node 24 is the only tested platform.
- [x] State GO is opt-in local evidence, not M6 production readiness.
- [x] State NO-GO is a complete supported vector-free outcome.

### Verification checklist

```bash
pnpm vitest run tests/integration/g4b-artifact-integrity.test.ts
pnpm run verify:g4b
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm audit --audit-level high
git diff --check
```

- [x] Run a clean frozen-lockfile installation check.
- [x] Run vector-disabled build/start with optional dependencies omitted.
- [x] Run full-diff correctness, maintainability, testing, security, data
      integrity, reliability, performance, API-contract, and project-standards
      review sequentially in the main thread.
- [x] Resolve every critical/high finding and rerun affected gates.
- [x] Create the U8 commit.

**Rollback point:** documentation/evidence is additive and remains useful for a
NO-GO.

## 11. U9 — G4B decision, parent handoff, archive, and journal

**Requirements:** R9–R14, R19–R20; F4; M4B-AC9.

**Depends on:** U8 or the earliest hard-stop evidence.

**Files:**

- `docs/evaluations/g4b-decision.md`
- `docs/evaluations/vector-scorecard.md`
- `docs/adr/0004-local-vector-adoption.md`
- `docs/plans/2026-07-29-004-feat-local-vector-adoption-plan.md`
- `docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md`
- `.trellis/tasks/07-28-agent-memory-runtime/implement.md`
- `.trellis/tasks/07-29-agent-memory-runtime-m4b/prd.md`
- `.trellis/tasks/07-29-agent-memory-runtime-m4b/implement.md`
- `.trellis/tasks/07-29-agent-memory-runtime-m4b/task.json`
- Trellis archive and workspace journal artifacts.

### Decision checklist

- [x] Identify the first failed hard gate, if any.
- [x] Confirm no candidate substitution or threshold tuning occurred after
      freeze.
- [x] Confirm dependency/audit/offline/process gate result.
- [x] Confirm governance/privacy/correction/purge/restore/recovery result.
- [x] Confirm disabled/degraded vector-free equality and fallback result.
- [x] Confirm four-arm semantic utility and pollution result.
- [x] Confirm M0 latency and separately reported resource result.
- [x] Confirm evidence verifier and full review result.

### GO path

- [x] Skipped by verified `NO-GO`: hybrid passes `0/6`, not `>=5/6`.
- [x] Skipped by verified `NO-GO`: hybrid records `0`, not `>=4`, strict
      gains and has no holdout or transfer gain.
- [x] Skipped by verified `NO-GO`: two negative-control regressions remain;
      pollution delta alone is zero.
- [x] Skipped by verified `NO-GO`: successful governed recall and Context
      outcomes fail even though typed fallback latency passes.
- [x] Skipped by verified `NO-GO`: utility and resource hard gates are false.
- [x] `semantic_vector` remains disabled; no opt-in adoption is activated.
- [x] Name vector-free fallback and M6 limitations.

### NO-GO path

- [x] Record the first failed hard gate without obscuring later measurements.
- [x] Keep `semantic_vector` disabled and stop maintenance by default.
- [x] Keep FTS5/recency/layered/SQLite relations as active supported runtime.
- [x] Preserve candidate/evaluation evidence for a future dated gate.
- [x] Do not install/enable another model or index.

### Closure checklist

- [x] Write the G4B decision and update scorecard/ADR.
- [x] Update unified M4B plan frontmatter/status/tested commit/decision.
- [x] Mark all completed/skipped checklist items honestly.
- [x] Update M4B PRD acceptance boxes from verified evidence only.
- [x] Update parent roadmap M4B/G4B boxes and preserve M5/M6 pending.
- [x] Run artifact verifier against final decision identities.
- [x] Run task-native Trellis context and status validation.
- [ ] Finish/archive the child task without pushing or creating a PR.
- [ ] Write the Trellis workspace journal with commits, tests, decision,
      limitations, and next M5 handoff.
- [x] Commit decision, archive, journal, and any final closure correction as
      separate logical units.

### Final verification

```bash
pnpm run verify:g4b
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm audit --audit-level high
git diff --check
```

### Completion evidence

- [x] G4B has exactly one verified GO or NO-GO result.
- [x] Exactly one supported runtime path is active and documented.
- [ ] Task is archived, journaled, clean, and ready for M5.

## 12. Global decision rule

G4B `GO` is legal only if every hard gate is true. The first false hard gate
makes G4B `NO-GO`. Missing evidence is false. A failed utility/resource gate
cannot be repaired by changing the candidate, thresholds, holdout data,
Context budget, authority rules, or expected profile inside M4B.

Both terminal decisions complete the milestone. Only U9 activates the outcome.
