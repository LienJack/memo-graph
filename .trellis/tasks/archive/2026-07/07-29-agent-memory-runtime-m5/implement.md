# Agent Memory Runtime M5 — Execution Checklist

## 1. Execution contract

This checklist executes
`docs/plans/2026-07-29-005-feat-governed-learning-lab-plan.md`.

Rules:

- Keep the Trellis task in `planning` until this file, `design.md`, both
  context manifests, and `task.py validate` pass.
- After activation, execute U1-U9 in dependency order.
- Load `trellis-before-dev` before editing each unit and `trellis-check` after
  its focused implementation.
- Run Node commands only after:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
```

- Start each unit from a clean worktree.
- Write/freeze the failing test or fixture before the behavior it specifies.
- Stop on a focused verification failure; do not hide, weaken, or remove a
  gate.
- Complete exactly one logical task, verify it, and create exactly one commit.
  Do not batch two U-IDs or amend a prior task commit.
- Preserve unrelated user changes if they appear.
- Do not push, open a PR, or publish externally without explicit user
  authorization.
- U8 evidence runs from the clean committed U7 tree.
- U9 decision reads verifier-backed evidence only.
- Archive and journal are closure tasks after U9 and each receives its own
  commit.

Planned commit map:

| Task | Commit subject |
| --- | --- |
| ce-plan | `docs(m5): plan governed learning lab` |
| task activation | `chore(trellis): start M5 learning lab` |
| U1 | `feat(contracts): freeze governed learning artifacts` |
| U2 | `feat(storage): persist learning release ledger` |
| U3 | `feat(learning): seal traces and qualify candidates` |
| U4 | `feat(learning): evaluate protected three-arm runs` |
| U5 | `feat(learning): govern lifecycle authority and canary` |
| U6 | `feat(learning): publish and roll back releases` |
| U7 | `feat(mcp): expose governed learning controls` |
| U7R | `fix(learning): harden governed learning controls` |
| U8 | `docs(learning): bind G5 verification evidence` |
| U9 | `docs(learning): record G5 decision` |
| archive | `chore(trellis): archive M5 learning lab` |
| journal | `docs(trellis): record M5 learning lab session` |

If a unit must be split because implementation proves it is not atomic, update
both durable plans first. Assign a new stable U-ID and do not renumber the
existing units.

## 2. Non-negotiable invariants

- [x] SQLite remains the sole authority for learning state, release pointers,
      canonical memory, approval consumption, idempotency, and receipts.
- [x] Graph stays G4A `NO-GO`; vector stays G4B `NO-GO`; all G5 arms are
      vector-free.
- [x] Proposal, evaluation, and canary do not change normal runtime behavior or
      the active release pointer.
- [x] A learned retrieval policy only narrows the operator policy and cannot
      encode ACL, sensitivity, mandatory-exclusion, or safety rules.
- [x] Memory/procedure candidates reference canonical content; learning tables
      never store a duplicate body.
- [x] Candidate, trace, result, release-version, monitor, and rollback history
      is immutable and replayable.
- [x] Holdout/transfer expected output is invisible to proposal/calibration.
- [x] Every case has `no_candidate`, `current`, and `candidate` under identical
      common identity.
- [x] Any critical regression, contamination, missing evidence, or identity
      drift blocks release.
- [x] Canary authorization is exact and pre-canary; release/rollback approval
      is separate, post-canary, exact, fresh, externally controlled,
      single-use, and atomically consumed.
- [x] Pause blocks learning transitions only; core governed read/write
      continues.
- [x] Rollback restores the named prior pointer without resurrecting invalid
      content.
- [x] Old frozen Context remains historical; new requests resolve the current
      release.
- [x] Synthetic G5 evidence is never described as production improvement or
      M6 readiness.

## 3. U1 — Freeze contracts, thresholds, and protected fixtures

**Requirements:** R16-R20; F4; AE6/AE7.

**Depends on:** None.

**Files:**

- `packages/contracts/src/learning.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/tool-inputs.ts`
- `packages/contracts/src/projections.ts`
- `packages/contracts/src/receipts.ts`
- `packages/contracts/src/replay.ts`
- `packages/contracts/src/index.ts`
- `fixtures/g5/manifest.json`
- `fixtures/g5/thresholds.json`
- `fixtures/g5/{calibration,holdout,transfer,canary}/*.json`
- `tests/contract/learning.contract.test.ts`
- `tests/contract/mcp.contract.test.ts`
- `tests/contract/receipts.contract.test.ts`
- `tests/fixtures/g5-overlay.fixture.test.ts`

### Pre-development

- [x] Load `trellis-before-dev` for the active task.
- [x] Re-read PRD sections for trace, three arms, partitions, authority,
      pause, rollback, and G5 evidence.
- [x] Search all consumers of `LearningTraceSchema`,
      `CandidateChangeSchema`, `EvaluationArmSchema`,
      `EvaluationPartitionSchema`, `EvalResultSchema`, and
      `ReleasePointerSchema`.
- [x] Capture current G3R/G4A/G4B artifact hashes and prove they decode before
      adding optional learning fields.
- [x] Confirm fixture partitions and D5 thresholds are frozen before candidate
      behavior exists.

### Test-first checklist

- [x] Add one minimal valid fixture for every new persisted/cross-package
      artifact.
- [x] Reject trace without task spec, frozen Context identity, ordered
      trajectory refs, outcome/feedback/error/gap, active release/config,
      runtime identity, costs/side effects, redaction metadata, or valid seal.
- [x] Reject raw sensitive payload in a reference-only trace step.
- [x] Reject duplicated scopes, steps, evidence, cases, arms, transitions, or
      release IDs.
- [x] Reject obsolete `transcript_baseline`, `fts_baseline`, and `approved`
      vocabulary.
- [x] Accept only `no_candidate`, `current`, and `candidate`.
- [x] Accept only the legal candidate state vocabulary.
- [x] Require target/payload, base release, slot, expected improvement,
      protected invariants, evaluation contract, and rollback identity.
- [x] Reject executable/unknown payload and unsupported release capability.
- [x] Require all three evaluation partitions, at least three cases per
      partition, and three independent canary cases.
- [x] Reject partition/path/hash/visibility mismatch and post-freeze mutation.
- [x] Reject canary case/oracle access before `approved_for_canary`.
- [x] Require common identity equality across arms.
- [x] Require critical failures and measurement dimensions to remain separate.
- [x] Require canary authorization to bind evaluation plus the sealed canary
      manifest without a future receipt.
- [x] Require post-canary release/rollback approvals and release/monitor/
      control/rollback envelopes to bind exact upstream receipts/hashes.
- [x] Prove old artifacts without optional learning metadata preserve hashes.
- [x] Prove D5 thresholds and accepted G3R/G4A/G4B/vector-free identity are
      present in the manifest.

### Implementation checklist

- [x] Replace provisional trace/candidate/evaluation/release schemas with
      strict M5 artifacts.
- [x] Add ordered trace-step/redaction and evidence-reference schemas.
- [x] Add release capability, slot, target/payload, state-transition, common
      run identity, partition seal/visibility, evaluation receipt, canary
      authorization, post-canary approval, release version/pointer, monitor,
      control, rollback, and G5 schemas.
- [x] Extend effective configuration/receipts with optional active learning
      release identity while preserving absence compatibility.
- [x] Add exact learning MCP input contracts and approval-binding fields.
- [x] Export all public schemas/builders/types from one owner.
- [x] Freeze G5 evaluation/canary cases, thresholds, and manifest hashes.
- [x] Keep holdout/transfer expected values in protected files referenced by
      descriptors.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/contract/learning.contract.test.ts \
  tests/contract/mcp.contract.test.ts \
  tests/contract/receipts.contract.test.ts \
  tests/fixtures/g5-overlay.fixture.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Every invalid fixture fails for its declared boundary.
- [x] All cases/partitions/thresholds/baselines are frozen and hashed.
- [x] Existing decision artifact compatibility is exact.
- [x] `trellis-check` has no unresolved finding for U1.
- [x] Create only the U1 commit.

**Rollback point:** revert U1; no migration, learning package, or runtime
effect exists.

## 4. U2 — SQLite learning ledger, state, and frontiers

**Requirements:** R16-R20; F4.

**Depends on:** U1.

**Files:**

- `migrations/0014-learning-lab.sql`
- `packages/storage-sqlite/src/learning-repository.ts`
- `.trellis/spec/backend/database-guidelines.md`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/restore.ts`
- `packages/storage-sqlite/src/purge-repository.ts`
- `packages/storage-sqlite/src/index.ts`
- `tests/storage/learning-lab-schema.integration.test.ts`
- `tests/recovery/learning-ledger.recovery.test.ts`
- `tests/security/learning-ledger-residual.test.ts`

### Pre-development

- [x] Load `trellis-before-dev`.
- [x] Read backend database, error, logging, quality, cross-layer, and reuse
      specs.
- [x] Characterize migration upgrade/reopen, writer-worker serialization,
      append-only triggers, idempotency replay, approval consumption, and
      transaction rollback.
- [x] Map every new table to its owning contract and public storage operation.
- [x] Confirm no migration 0014 exists and migration numbering is contiguous.

### Test-first checklist

- [x] Upgrade a current M4B database without changing old rows/hashes/counts
      except additive health fields.
- [x] Append/re-read a complete trace and ordered evidence references.
- [x] Append/re-read immutable candidate and ordered trace links.
- [x] Append a legal transition sequence and derive current state.
- [x] Reject illegal/backward/duplicate/stale transition.
- [x] Persist partition seals, runs, arm results, contamination events, and
      evaluation receipts.
- [x] Persist bounded canary, release version, active pointer, monitor,
      control, and rollback records.
- [x] Enforce one active pointer per canonical slot and monotonic pointer
      revision.
- [x] Enforce one control row/epoch per principal and expected-frontier CAS.
- [x] Replay same idempotency key/hash and conflict on changed hash.
- [x] Reject foreign principal/scope, wrong base/slot/target, reused approval,
      and mismatched receipt chain.
- [x] Inject failure before/after every pointer, control, transition, approval,
      idempotency, canonical effect, outbox, and receipt write.
- [x] Reopen after each failure and assert entire old or entire new state.
- [x] Prove immutable rows cannot update/delete.
- [x] Prove worker protocol rejects unknown/malformed request/response.
- [x] Tombstone/purge a referenced memory and prove the learning target becomes
      unresolvable.
- [x] Scan SQLite/WAL/diagnostics for marker content not authorized for
      learning retention.
- [x] Carry learning release/control frontier through health and restore
      refusal checks.

### Implementation checklist

- [x] Add typed tables, checks, unique keys, foreign keys, indexes, and
      append-only/guard triggers.
- [x] Add immutable trace/candidate/transition/evaluation/canary/release/
      monitor/rollback persistence.
- [x] Add guarded active pointer and learning control CAS.
- [x] Couple effects, idempotency, approval consumption, transition, and
      receipt in one immediate transaction.
- [x] Add strict protocol schemas and decoded worker/client operations.
- [x] Extend health/count/frontier output without leaking content.
- [x] Integrate target invalidation with revoke/tombstone/purge.
- [x] Extend restore validation to refuse a snapshot behind required learning
      release/control frontiers.
- [x] Export only the public storage surface.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/storage/learning-lab-schema.integration.test.ts \
  tests/recovery/learning-ledger.recovery.test.ts \
  tests/security/learning-ledger-residual.test.ts \
  tests/storage/data-root-and-migrations.integration.test.ts \
  tests/storage/evidence-ledger.integration.test.ts \
  tests/governance/revision-cas.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Upgrade/reopen, worker decoding, CAS, append-only, idempotency, approval,
      crash, purge, and restore tests pass.
- [x] Learning storage contains no duplicated memory/procedure content.
- [x] `trellis-check` has no unresolved U2 finding.
- [x] Create only the U2 commit.

**Rollback point:** revert U2 and migration 0014 together; no learning runtime
consumer exists.

## 5. U3 — Trace recorder and smallest candidate

**Requirements:** R16, R18, R19; F4.

**Depends on:** U1, U2.

**Files:**

- `packages/learning-lab/package.json`
- `packages/learning-lab/tsconfig.json`
- `packages/learning-lab/src/trace-recorder.ts`
- `packages/learning-lab/src/candidate-builder.ts`
- `packages/learning-lab/src/index.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/learning-repository.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/index.ts`
- `package.json`
- `tests/learning/trace-and-candidate.test.ts`
- `tests/security/learning-trace-redaction.test.ts`
- `tests/integration/learning-candidate-boundary.integration.test.ts`

### Pre-development

- [x] Load `trellis-before-dev`.
- [x] Confirm package dependency direction: contracts + public storage port
      only; no driver, MCP SDK, graph/vector, or model dependency.
- [x] Search existing canonical seal, governance admission, evidence lookup,
      Context lookup, scope normalization, and stop-reason patterns.
- [x] Freeze deterministic qualification rules; do not add an LLM heuristic.

### Test-first checklist

- [x] Complete task evidence creates one valid sealed trace.
- [x] Same ordered input replays one trace; changed input under same key
      conflicts.
- [x] Reordered steps change the trace seal.
- [x] Positive, negative, and conflicting observations remain distinct.
- [x] Missing task/Context/config/outcome/failure/provenance emits stop and zero
      candidate.
- [x] Paused control epoch emits stop and zero candidate.
- [x] Foreign/purged/inaccessible evidence emits stop and zero candidate.
- [x] Sensitive raw content is referenced/redacted and marker-free in learning
      rows/errors.
- [x] Smallest candidate ordering chooses memory, procedure, then narrowing
      retrieval policy.
- [x] Prompt/Core/Scenario is evaluation-only.
- [x] Skill/code/model candidate is unsupported.
- [x] Candidate without exact base/slot/target/invariants/evaluation/rollback
      is rejected.
- [x] Proposal leaves active pointer, normal Context, and canonical memory
      byte-identical.

### Implementation checklist

- [x] Implement trace completeness, evidence/Context resolution, redaction,
      canonical sealing, persistence, and idempotent replay.
- [x] Preflight idempotent replay by normalized request identity before
      rereading mutable evidence, control, policy, or target state.
- [x] Implement typed stop reasons without raw content.
- [x] Implement deterministic candidate qualification and capability.
- [x] Bind trace set, base release, slot, target/payload, improvement,
      invariants, risk, authority, evaluation, and rollback.
- [x] Persist only inactive immutable candidates.
- [x] Export the minimal public Learning Lab surface.
- [x] Add the package to the runtime build before its first consumer.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/learning/trace-and-candidate.test.ts \
  tests/security/learning-trace-redaction.test.ts \
  tests/integration/learning-candidate-boundary.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Complete evidence creates one replayable inactive candidate.
- [x] Every incomplete/unsafe path records a stop with zero publication.
- [x] Package dependency boundary is clean.
- [x] `trellis-check` has no unresolved U3 finding.
- [x] Create only the U3 commit.

**Rollback point:** remove the package and root build entry; U1/U2 remain
unused contracts/storage.

## 6. U4 — Protected three-arm evaluation

**Requirements:** R17, R19, R20; F4; AE6.

**Depends on:** U3.

**Files:**

- `packages/learning-lab/src/partition-loader.ts`
- `packages/learning-lab/src/evaluation-runner.ts`
- `packages/learning-lab/src/index.ts`
- `tests/helpers/g5-replay.ts`
- `tests/helpers/learning-examples.ts`
- `tests/learning/three-arm-evaluation.test.ts`
- `tests/security/learning-partition-isolation.test.ts`
- `tests/replay/learning-negative-transfer.test.ts`

### Pre-development

- [x] Load `trellis-before-dev`.
- [x] Characterize G3/G4A/G4B replay common-identity and separated-score
      helpers.
- [x] Map file/module boundaries so proposal/calibration code cannot import
      holdout/transfer expected bodies.
- [x] Confirm isolated arm storage/runtime reset strategy.

### Test-first checklist

- [x] Run all three arms for every calibration/holdout/transfer case.
- [x] Assert every common-identity field is exact across arms.
- [x] Assert only candidate/release application differs.
- [x] Reject missing/duplicate arm and incomplete case.
- [x] Reject changed input, Context, reader, tool, budget, runtime, policy,
      lock, scorer, seed, threshold, environment, or baseline decision.
- [x] Reject candidate/fixture mutation after freeze.
- [x] Detect holdout/transfer expected-output access by proposal/calibration.
- [x] Record contamination and invalidate the run.
- [x] Report task, error, negative transfer, Context/tokens, latency, side
      effects, scope/privacy/governance, and critical failures separately.
- [x] Reject any evaluation side effect on normal pointer/canonical memory.
- [x] Reject calibration-only gain with holdout/transfer harm.
- [x] Replay identical identity to identical logical results/hashes.
- [x] Give changed identity a new run and prevent approval reuse.

### Implementation checklist

- [x] Implement partition descriptor/visibility loader and sealed scorer
      boundary.
- [x] Freeze common identity before arm execution.
- [x] Execute arms from isolated equivalent state.
- [x] Collect strict per-case result contracts.
- [x] Evaluate D5 conjunctive thresholds without a compensating aggregate.
- [x] Persist per-case results, contamination, invalidation, and evaluation
      receipt.
- [x] Expose content-free logical result helpers for G5 scripts.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/learning/three-arm-evaluation.test.ts \
  tests/security/learning-partition-isolation.test.ts \
  tests/replay/learning-negative-transfer.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Every case has three comparable arms or a typed invalidation.
- [x] Leakage/drift/side-effect protection is executable.
- [x] Harmful/overfit candidates cannot pass.
- [x] `trellis-check` has no unresolved U4 finding.
- [x] Create only the U4 commit.

**Rollback point:** remove evaluator/loader/helper files; trace/candidate-only
operation remains.

## 7. U5 — Lifecycle, authority, and canary

**Requirements:** R17-R20; F4; AE6.

**Depends on:** U2, U4.

**Files:**

- `packages/learning-lab/src/lifecycle.ts`
- `packages/learning-lab/src/canary-runner.ts`
- `packages/learning-lab/src/partition-loader.ts`
- `packages/learning-lab/src/index.ts`
- `packages/contracts/src/learning.ts`
- `packages/contracts/src/mcp.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/learning-repository.ts`
- `packages/memory-kernel/src/approval.ts`
- `packages/mcp-server/src/mutations.ts`
- `.trellis/spec/backend/database-guidelines.md`
- `tests/helpers/g5-canary.ts`
- `tests/helpers/learning-examples.ts`
- `tests/learning/candidate-lifecycle.test.ts`
- `tests/learning/learning-canary.test.ts`
- `tests/security/learning-release-authorization.test.ts`
- `tests/storage/learning-lab-schema.integration.test.ts`
- `tests/recovery/learning-ledger.recovery.test.ts`

### Pre-development

- [x] Load `trellis-before-dev`.
- [x] Characterize current grant parsing, manifest hashing, exact matching,
      time checks, confirm-unchanged, and consumption behavior.
- [x] Search every exhaustive tool/approval mapping before extending it.
- [x] Freeze three independent canary cases before candidate behavior, keep
      them inaccessible until approval, and freeze one exposure per case plus
      a ten-minute deadline and promote/abort rules.
- [x] Freeze distinct canary-authorization and post-canary release-approval
      identities so no grant binds a receipt that does not exist yet.

### Test-first checklist

- [x] Replay the one legal state path to release/rollback.
- [x] Reject every skip, backward move, stale expected transition, and
      terminal-state transition.
- [x] Same transition idempotency/hash replays; changed hash conflicts.
- [x] Approve only complete valid evaluation with all D5 offline rules.
- [x] Reject evaluation-only/unsupported capability before canary.
- [x] Reject missing/expired/changed/wrong principal/tool/scope/candidate/
      slot/base/evaluation/request/manifest canary authorization.
- [x] Reject any canary authorization that attempts to bind a precomputed
      terminal canary receipt.
- [x] Reject missing/expired/changed/wrong principal/tool/scope/candidate/
      slot/base/evaluation/canary-receipt/pointer/request/manifest
      post-canary release or rollback approval.
- [x] Prove proposer/evaluator evidence cannot authorize release.
- [x] Prove canary authorization is consumed exactly once when canary starts.
- [x] Prove one post-canary approval is consumed once and the same release or
      rollback request replays afterward.
- [x] Preserve old non-learning approval grants/hashes.
- [x] Canary uses exact stable/current comparator and frozen cases.
- [x] Canary rejects early case/oracle visibility.
- [x] Canary passes only inside exposure/time/metric bounds.
- [x] Canary aborts/freezes on critical regression, drift, pause, timeout,
      missing stable, or exposure overflow.
- [x] Canary never changes the normal active pointer.

### Implementation checklist

- [x] Implement one exhaustive state reducer and transition validator.
- [x] Persist state-changing transitions through storage CAS.
- [x] Extend approval contracts/registry binding only for learning tools, with
      separate canary-authorization and post-canary approval schemas.
- [x] Confirm the canary manifest at canary start and atomically consume its
      authorization.
- [x] Commit the canary state transition, authorization, terminal run,
      receipt, and idempotency result in the same SQLite transaction.
- [x] Confirm the effect manifest at release/rollback boundary and prepare
      exact post-canary approval consumption data.
- [x] Implement frozen bounded canary runner and durable terminal receipt.
- [x] Keep canary execution candidate-only.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/learning/candidate-lifecycle.test.ts \
  tests/learning/learning-canary.test.ts \
  tests/security/learning-release-authorization.test.ts \
  tests/mcp/governance-mutations.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Legal state replay, illegal-transition rejection, exact authority, and
      bounded canary pass.
- [x] Non-learning approval behavior is unchanged.
- [x] `trellis-check` has no unresolved U5 finding.
- [x] Create only the U5 commit.

**Rollback point:** remove lifecycle/canary behavior and learning grant fields;
candidate remains evaluated but cannot publish.

## 8. U6 — Release, active runtime policy, and rollback

**Requirements:** R17-R20; F4; AE6.

**Depends on:** U5.

**Files:**

- `packages/learning-lab/src/release-manager.ts`
- `packages/learning-lab/src/index.ts`
- `packages/storage-sqlite/src/learning-repository.ts`
- `packages/storage-sqlite/src/governance-repository.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/database.ts`
- `packages/storage-sqlite/src/storage-worker.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/memory-kernel/src/recall-orchestrator.ts`
- `packages/context-compiler/src/receipt-builder.ts`
- `packages/contracts/src/projections.ts`
- `packages/contracts/src/receipts.ts`
- `tests/helpers/g5-release.ts`
- `tests/helpers/g5-replay.ts`
- `tests/helpers/learning-examples.ts`
- `tests/integration/learning-release.integration.test.ts`
- `tests/governance/learning-memory-release.integration.test.ts`
- `tests/recovery/learning-release-rollback.recovery.test.ts`
- `tests/replay/learning-release-pointer.test.ts`
- `tests/recovery/learning-ledger.recovery.test.ts`
- `tests/storage/learning-lab-schema.integration.test.ts`

### Pre-development

- [x] Load `trellis-before-dev`.
- [x] Characterize base Context output/hash with no active learning release.
- [x] Characterize canonical memory revision creation, outbox coupling,
      frozen recall replay, and transaction guards.
- [x] Decide the smallest private governance transaction adapter and document
      any plan-consistent file adjustment before editing.
- [x] Freeze crash-injection boundaries.

### Test-first checklist

- [x] No active pointer equals accepted vector-free baseline.
- [x] Exact scope-set slot normalizes order deterministically.
- [x] Subset/superset/foreign scope does not resolve the release.
- [x] Retrieval candidate may remove lanes/lower limits.
- [x] Reject adding lanes, raising limits, enabling graph/vector, or changing
      ACL, sensitivity, mandatory-exclusion, hard-filter, or governance
      behavior.
- [x] Seal resolved release/config hash into recall/Context receipts.
- [x] Release memory/procedure from canonical candidate without copying
      content or updating immutable revision.
- [x] Commit canonical successor, status/admission, outbox, release version,
      pointer, transition, approval, idempotency, and receipt atomically.
- [x] Inject failure at each write and observe old-or-new state after reopen.
- [x] Two concurrent release/rollback requests from one pointer yield one
      winner and one conflict.
- [x] Pause and release serialize on the observed control epoch: pause-first
      makes release stale; release-first makes pause record
      `RELEASE_COMPLETED_BEFORE_PAUSE` and leaves rollback explicit.
- [x] New request after release uses the new pointer.
- [x] Old request ID replays original frozen Context.
- [x] Rollback restores exact named prior release pointer and prior
      behavior/config hash on a new request.
- [x] Reject rollback to revoked/tombstoned/purged/cross-scope/changed target.
- [x] Approval is consumed iff effect exists after crash.
- [x] Normal runtime starts and serves without an evaluator/candidate process.

### Implementation checklist

- [x] Implement release/rollback orchestration and exact command contracts.
- [x] Implement private atomic storage transaction composition.
- [x] Implement immutable release version and active-pointer CAS.
- [x] Implement retrieval-policy release resolver and narrow-only
      intersection.
- [x] Keep ACL, sensitivity, mandatory-exclusion, and other safety filters
      outside learned policy payloads and active under base fallback.
- [x] Implement canonical memory/procedure append-only release adapter.
- [x] Implement rollback version, target validation, inverse canonical/
      projection effects, and no-resurrection guard.
- [x] Include active release identity in effective config and receipts.
- [x] Preserve old frozen request replay and base behavior.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/integration/learning-release.integration.test.ts \
  tests/governance/learning-memory-release.integration.test.ts \
  tests/recovery/learning-release-rollback.recovery.test.ts \
  tests/replay/learning-release-pointer.test.ts \
  tests/integration/frozen-layered-context-slice.integration.test.ts \
  tests/integration/layered-runtime-regression.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Release/rollback atomicity and no-resurrection pass.
- [x] Learned policy only narrows; base behavior remains exact without a
      pointer.
- [x] Canonical memory/procedure content has one authority.
- [x] `trellis-check` has no unresolved U6 finding.
- [x] Create only the U6 commit.

**Rollback point:** restore base pointer/disable release resolution, then
revert U6; evaluated candidate history remains inactive.

## 9. U7 — MCP feedback and learning controls

**Requirements:** R16-R20; F4; AE7.

**Depends on:** U6.

**Files:**

- `packages/contracts/src/tool-inputs.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/learning.ts`
- `packages/learning-lab/src/learning-stop.ts`
- `packages/learning-lab/src/release-manager.ts`
- `packages/learning-lab/src/index.ts`
- `packages/memory-kernel/package.json`
- `packages/mcp-server/src/index.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `packages/storage-sqlite/src/learning-repository.ts`
- `tests/helpers/g5-release.ts`
- `tests/mcp/learning-controls.integration.test.ts`
- `tests/integration/learning-pause-runtime-continuity.integration.test.ts`
- `tests/recovery/learning-pause-resume.recovery.test.ts`

### Pre-development

- [x] Load `trellis-before-dev`.
- [x] Search every MemoryToolName, safety-class, metadata, annotation,
      registration, approval, and runtime exhaustive mapping.
- [x] Characterize ordinary search/get/Context/mutation while no learning
      control handler exists.
- [x] Freeze control epoch/frontier identity and in-flight policy.

### Test-first checklist

- [x] `memory_feedback` stores governed evidence/trace input and has no release
      effect.
- [x] Pause with exact trusted request advances one control epoch and receipt.
- [x] Pause replay is idempotent; changed request conflicts.
- [x] While paused, search/get/Context compile succeeds.
- [x] While paused, one authorized ordinary memory mutation succeeds.
- [x] While paused, new candidate/evaluation/canary/release transition stops.
- [x] Running evaluation may write terminal receipt but cannot approve/publish.
- [x] Running canary freezes/aborts and cannot publish.
- [x] Pause/release concurrency follows the SQLite control-epoch ordering and
      emits the specified release-before-pause reason when applicable.
- [x] Resume succeeds only with exact expected epoch/frontier and unchanged
      runtime/config/corpus identity.
- [x] Drift forces reevaluation or explicit abandonment.
- [x] Release/rollback rejects wrong actor/scope/safety/expected pointer/
      approval/evaluation/canary.
- [x] Every tool has one exact safety class and correct annotations.
- [x] Learning inspection resource contains content-free status/IDs/hashes.
- [x] Restart preserves pause/control, active pointer, and frozen work.
- [x] Error/resource/log output omits raw learning/evidence/Context content.

### Implementation checklist

- [x] Complete input schemas and runtime handlers for the five M5 tools.
- [x] Register exhaustive metadata and MCP tools.
- [x] Implement content-free inspection resource.
- [x] Implement pause/resume CAS, idempotency, approval, receipt, and frontier
      revalidation.
- [x] Keep core memory paths independent of learning pause.
- [x] Map known failures to stable governed response codes.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/mcp/learning-controls.integration.test.ts \
  tests/integration/learning-pause-runtime-continuity.integration.test.ts \
  tests/recovery/learning-pause-resume.recovery.test.ts \
  tests/contract/mcp.contract.test.ts \
  tests/mcp/governance-mutations.integration.test.ts \
  tests/integration/codex-explicit-loop.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] All reserved M5 tool names have implementation/metadata parity.
- [x] Pause/resume is durable without core runtime degradation.
- [x] Every effect-bearing call returns durable evidence.
- [x] `trellis-check` has no unresolved U7 finding.
- [x] Create only the U7 commit.

**Rollback point:** unregister M5 handlers and keep learning publication
disabled; base MCP/runtime continues.

## 9A. U7R — Resolve required U7 review findings

**Requirements:** R16-R20; F4; AE7.

**Depends on:** U7.

**Files:**

- `packages/contracts/src/receipts.ts`
- `packages/contracts/src/tool-inputs.ts`
- `packages/contracts/src/learning.ts`
- `packages/learning-lab/src/learning-stop.ts`
- `packages/learning-lab/src/release-manager.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/mcp-server/src/index.ts`
- `packages/storage-sqlite/src/learning-repository.ts`
- `tests/contract/receipts.contract.test.ts`
- `tests/mcp/learning-controls.integration.test.ts`
- `tests/integration/learning-pause-runtime-continuity.integration.test.ts`
- `tests/recovery/learning-pause-resume.recovery.test.ts`
- `tests/integration/learning-release.integration.test.ts`

### Review-fix gate

- [x] Persist the privacy-minimal `memory_feedback` task/Context/outcome/
      evidence/error/gap observation in the durable receipt and prove restart
      readback without raw content.
- [x] Bound feedback evidence/scope lookup work and reject foreign exact-scope
      evidence without a learning write.
- [x] Require principal-wide pause/resume requests and approvals to use the
      configured complete scope set.
- [x] Derive runtime, configuration, and corpus identities from authoritative
      runtime/storage state; expose those content-free identities for MCP
      action preparation.
- [x] Remove the global maximum-control-epoch comparison from principal-local
      pause/resume validation and prove two principals can advance
      independently.
- [x] Persist one principal-scoped learning-work frontier over candidate,
      evaluation, canary, release, pointer, monitor, and invalidation state.
- [x] Reject resume after allowed paused-state terminal work or corpus drift
      unless the approved request explicitly abandons in-flight work.
- [x] Serialize release-first/pause-first correctly and emit
      `RELEASE_COMPLETED_BEFORE_PAUSE` only for an observed release-first
      retry.
- [x] Block release while paused but permit an exact authorized safety
      rollback from the current control epoch.
- [x] Mark failed governed MCP tool results with `isError` and exercise all
      five tools plus the learning resource through an MCP client transport.
- [x] Add negative release/rollback actor, scope, receipt, pointer, control,
      manifest, monitor, and approval assertions with zero unintended effect.
- [x] Queue non-blocking review debt explicitly for the U8 review report.

Queued U8 review-report debt:

- Extract learning-control orchestration from the growing
  `MemoryRuntime` module without changing the governed boundary.
- Validate feedback `context_slice_id` provenance instead of accepting only
  its privacy-minimal identifier.
- Replace the bounded evidence-by-scope lookup loop with a batched repository
  query if G5 resource evidence shows material cost.
- Narrow the conservative global corpus identity to principal/exact-scope
  state if false-positive drift becomes operationally significant.
- Extend MCP action preparation beyond pause/resume identities to exact
  release/rollback readiness and remove any remaining handwritten internal
  release execution payload duplication.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/contract/receipts.contract.test.ts \
  tests/mcp/learning-controls.integration.test.ts \
  tests/integration/learning-pause-runtime-continuity.integration.test.ts \
  tests/recovery/learning-pause-resume.recovery.test.ts \
  tests/integration/learning-release.integration.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [x] Every verified U7 P0/P1 review finding is fixed or explicitly
      reclassified with code-backed evidence.
- [x] Full repository gates pass without the known archived G4B verifier
      path defect.
- [x] `trellis-check` has no unresolved U7R finding.
- [x] Create only the U7R commit; do not amend U7 or include U8 evidence.

**Rollback point:** revert U7R and keep publication disabled; the committed U7
tree remains available for forensic comparison but cannot be used for G5
evidence.

## 9B. U7S — Preserve archived G4B evidence verification

**Requirement:** evidence continuity prerequisite for U8 full-suite closure.

**Depends on:** U7R and the archived M4B task.

- [x] Resolve the immutable M4B U2/U6 gate artifacts from either their active
      Trellis task or the canonical monthly archive.
- [x] Add a regression that proves the current archived path is selected.
- [x] Run the focused G4B artifact-integrity test and full repository suite.
- [x] Create only the U7S maintenance commit; exclude all in-progress U8
      evidence files.

**Rollback point:** revert U7S and continue excluding the archived G4B
artifact-integrity test; this does not alter runtime behavior or the historical
G4B `NO-GO`.

## 10. U8 — G5 evidence capture and verification

**Requirements:** R16-R20; F4; AE6/AE7.

**Depends on:** U4, U7R.

**Files:**

- `scripts/run-g5-replay.mjs`
- `scripts/run-g5-canary.mjs`
- `scripts/run-g5-resource-report.mjs`
- `scripts/verify-g5-evidence.mjs`
- `package.json`
- `tests/helpers/g5-replay.ts`
- `tests/integration/g5-artifact-integrity.test.ts`
- `docs/evaluations/g5-replay-report.json`
- `docs/evaluations/g5-canary-report.json`
- `docs/evaluations/g5-resource-report.json`
- `docs/evaluations/g5-reproducibility-manifest.json`
- `docs/evaluations/g5-verification-report.json`
- `docs/evaluations/g5-code-review.md`

### Pre-evidence gate

- [x] Worktree is clean on committed U7R plus the isolated U7S archived-evidence
      verifier maintenance commit.
- [x] Record tested commit/tree and lockfile hash before executing.
- [x] Record migration, runtime, platform, G3R/G4A/G4B, retrieval config,
      fixture, partition, threshold, scorer, and seed identities.
- [x] Confirm graph/vector remain disabled/default-off.
- [x] Confirm candidate was frozen before holdout/transfer execution.

### Harness checklist

- [x] Run one complete safe narrowing retrieval-policy path.
- [x] Run one harmful calibration-only/negative-transfer path.
- [x] Prove safe path has all three arms and D5 per-partition deltas.
- [x] Prove harmful path is rejected with zero pointer change.
- [x] Exercise exact approval and single consumption.
- [x] Exercise separate canary authorization and post-canary release approval;
      reject circular/precomputed canary-receipt binding.
- [x] Exercise bounded canary success and forced abort.
- [x] Prove exactly three independent canary exposures, no early visibility,
      and completion inside the frozen deadline.
- [x] Exercise release, monitor success/breach, pause, resume, rollback, and
      no-resurrection.
- [x] Replay each independent canary input exactly once through the active
      pointer for monitoring; prove a mismatch/breach blocks G5 until an
      authorized rollback receipt restores the safe pointer.
- [x] Exercise crash recovery at pointer/receipt/approval boundaries.
- [x] Exercise ordinary runtime continuity while paused and after NO-GO
      fallback.
- [x] Measure task units, errors, negative transfer, Context/tokens, latency,
      side effects, governance, privacy, release, and rollback separately.
- [x] Capture limitations and synthetic-evidence boundary.

### Evidence verifier checklist

- [x] Recompute source commit/tree and lockfile hash.
- [x] Recompute every migration, fixture, partition, threshold, scorer,
      report, approval, canary, release, monitor, rollback, and decision-input
      hash.
- [x] Verify G3R/G4A/G4B decisions and vector-free configuration.
- [x] Verify candidate/common identity and all three arms.
- [x] Verify D5 rules conjunctively.
- [x] Verify release/rollback receipt chain and exact prior pointer.
- [x] Verify canary authorization and post-canary release approval are distinct
      exact single-use chains.
- [x] Verify monitor replay consumed the active pointer and any breach remained
      a G5 blocker until authorized rollback.
- [x] Verify focused/full quality outputs and code-review result.
- [x] Fail on missing/tampered/extra unbound evidence.

### Focused and global verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm audit --audit-level high
pnpm g5:replay
pnpm g5:canary
pnpm g5:resources
pnpm verify:g5
```

Run the mandated code review on the committed U7 diff. Resolve every verified
P0/P1 finding before evidence capture; record lower-priority debt explicitly.

### Completion evidence

- [x] Full repository gates pass on the tested implementation.
- [x] Replay/canary/resource reports and manifest are generated from the
      committed tree.
- [x] Verifier reports every hard rule and passes artifact integrity.
- [x] Reports make no production/M6 claim.
- [x] Create only the U8 evidence commit; do not include the G5 decision.

### Recorded U8 evidence

- Tested implementation:
  `91d810efe17632e64f5e9a3ddae81f8e9f0b9985`,
  tree `34719539c098343b3d47771cb0588be905faf6c5`.
- Dependency lock:
  `sha256:89b71c57b48310cd99dee5a054be88d08c8af18363b465f8dca2a98b186c5f82`;
  migration set:
  `sha256:842ed0336266bd9a4ca7a740654671d021d1dff0bc294361b6ea9a5b17fb35b9`.
- Replay, canary, and resource hard rules passed; the independent verifier
  returned `ELIGIBLE_FOR_U9` while leaving `decision_recorded=false`.
- Manifest:
  `sha256:12fe4d89de233dbe43ae3e1c416ca58a1e07684ed9602085416e2e40db6c6fac`;
  verifier report:
  `sha256:8b8d41bd2242efd065ec7cb96528d8278b31cfaff37e3498799546311317e82f`.
- `pnpm test`: 98 files passed; 481 tests passed and 6 skipped.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`,
  `pnpm audit --audit-level high`, `pnpm g5:replay`, `pnpm g5:canary`,
  `pnpm g5:resources`, `pnpm verify:g5`, and the focused four-test G5
  artifact-integrity suite passed.
- The evidence is deterministic local synthetic evidence only. It contains no
  production-traffic, production-readiness, or M6-hardening claim.

**Rollback point:** delete/regenerate U8 evidence from the same tested commit;
do not change implementation to make the report pass without a new U-ID plan
revision.

## 11. U9 — G5 decision and parent handoff

**Requirements:** R16-R20; F4; AE6/AE7.

**Depends on:** U8 or earliest verified hard-stop evidence.

**Files:**

- `docs/evaluations/g5-decision.md`
- `docs/adr/0005-governed-learning-release.md`
- `docs/plans/2026-07-29-005-feat-governed-learning-lab-plan.md`
- `docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md`
- `.trellis/tasks/07-29-agent-memory-runtime-m5/task.json`
- `.trellis/tasks/07-29-agent-memory-runtime-m5/implement.md`

### Decision checklist

- [x] Read `docs/evaluations/g5-verification-report.json`.
- [x] Identify the first false hard rule, if any.
- [x] Confirm tested implementation commit and evidence commit are immutable.
- [x] Confirm active/base release and exact rollback target.
- [x] Confirm graph/vector decisions are unchanged.
- [x] Confirm full quality/review evidence applies to the tested tree.
- [x] Record exactly one result:
  - [x] GO only if every hard rule is true.
  - [x] NO-GO on any false/missing rule — evaluated but not selected because
        no verifier-backed hard rule is false or missing.
- [x] On GO, accept only the exact tested release and preserve pause/rollback;
      its synthetic test activation was followed by the required exact
      rollback drill, so no production pointer is claimed.
- [x] On NO-GO, retain/restore base pointer and prove candidate-only/core
      runtime continuity — not selected; the same fallback was nevertheless
      proven by the forced monitor-breach rollback.
- [x] Record limitations and synthetic-evidence boundary.
- [x] Update ADR 0005.
- [x] Update parent G5 row with exact tested implementation and decision path.
- [x] Mark this plan decision-complete without rewriting historical scope.
- [x] Mark U1-U9 checklist results honestly.

### Final verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm verify:g5
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

### Completion evidence

- [x] One verifier-backed G5 outcome exists.
- [x] Parent/ADR/plan/task metadata agree on tested/evidence commits, active
      release, fallback, and limitations.
- [x] M6 remains pending and starts from the recorded M5 baseline.
- [x] Create only the U9 decision commit.

### Recorded U9 decision

- Outcome: G5 `GO` for the exact local synthetic release path.
- Tested implementation:
  `91d810efe17632e64f5e9a3ddae81f8e9f0b9985`, tree
  `34719539c098343b3d47771cb0588be905faf6c5`.
- Immutable evidence commit:
  `b9c0907745cedf3315d7ab3f42a39c9afb8790eb`.
- Qualified release:
  `release:a8f7214a0c8a8db3b5f2515649b06c0ffc855ab68`.
- Base release and exact rollback target: `null`; the synthetic drill ended
  at restored pointer revision `2`.
- Decision: `docs/evaluations/g5-decision.md`; ADR:
  `docs/adr/0005-governed-learning-release.md`.
- Graph and vector remain disabled under G4A/G4B `NO-GO`; automatic learning
  publication remains disabled; M6/G6 remain pending.

**Rollback point:** revert the U9 documentation/metadata commit; U8 evidence
and tested implementation remain immutable.

## 12. Closure — archive and journal as separate tasks

After U9 is committed:

### Archive task

- [x] Re-run `task.py validate`.
- [x] Confirm no unchecked required implementation item remains.
- [x] Archive the M5 child with Trellis.
- [x] Confirm the parent child link resolves to the archive.
- [x] Create only the archive commit.

### Journal task

- [ ] Record branch, baseline, brainstorm, research run/gate, plan, U1-U9,
      tested/evidence/decision commits, G5 outcome, fallback, limitations, and
      next M6 child.
- [ ] Update the Trellis workspace index through the supported session script.
- [ ] Create only the journal commit.
- [ ] Confirm the worktree is clean.

Do not start or combine M6 in either closure commit.

## 13. Global G5 rule

G5 `GO` is legal only when every frozen D5 hard rule, authority/canary/
release/rollback proof, full repository gate, security check, evidence
integrity check, and required review is true.

Canary authorization and post-canary release approval are two distinct
single-use authority chains. Monitoring must prove the active pointer consumed
the independent canary inputs without mismatch; a monitor breach blocks `GO`
until an authorized rollback receipt restores the safe pointer.

The first false or missing hard rule makes G5 `NO-GO`. A NO-GO:

- retains/restores the accepted base pointer;
- leaves trace collection and candidate-only evaluation available;
- leaves ordinary governed recall and authorized writes operational;
- does not reopen graph/vector;
- completes M5 honestly.

Only U9 records the gate decision. U8 records evidence and may not decide by
narrative.
