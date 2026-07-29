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
| U8 | `docs(learning): bind G5 verification evidence` |
| U9 | `docs(learning): record G5 decision` |
| archive | `chore(trellis): archive M5 learning lab` |
| journal | `docs(trellis): record M5 learning lab session` |

If a unit must be split because implementation proves it is not atomic, update
both durable plans first. Assign a new stable U-ID and do not renumber the
existing units.

## 2. Non-negotiable invariants

- [ ] SQLite remains the sole authority for learning state, release pointers,
      canonical memory, approval consumption, idempotency, and receipts.
- [ ] Graph stays G4A `NO-GO`; vector stays G4B `NO-GO`; all G5 arms are
      vector-free.
- [ ] Proposal, evaluation, and canary do not change normal runtime behavior or
      the active release pointer.
- [ ] A learned retrieval policy only narrows the operator policy and cannot
      encode ACL, sensitivity, mandatory-exclusion, or safety rules.
- [ ] Memory/procedure candidates reference canonical content; learning tables
      never store a duplicate body.
- [ ] Candidate, trace, result, release-version, monitor, and rollback history
      is immutable and replayable.
- [ ] Holdout/transfer expected output is invisible to proposal/calibration.
- [ ] Every case has `no_candidate`, `current`, and `candidate` under identical
      common identity.
- [ ] Any critical regression, contamination, missing evidence, or identity
      drift blocks release.
- [ ] Canary authorization is exact and pre-canary; release/rollback approval
      is separate, post-canary, exact, fresh, externally controlled,
      single-use, and atomically consumed.
- [ ] Pause blocks learning transitions only; core governed read/write
      continues.
- [ ] Rollback restores the named prior pointer without resurrecting invalid
      content.
- [ ] Old frozen Context remains historical; new requests resolve the current
      release.
- [ ] Synthetic G5 evidence is never described as production improvement or
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

- [ ] Load `trellis-before-dev` for the active task.
- [ ] Re-read PRD sections for trace, three arms, partitions, authority,
      pause, rollback, and G5 evidence.
- [ ] Search all consumers of `LearningTraceSchema`,
      `CandidateChangeSchema`, `EvaluationArmSchema`,
      `EvaluationPartitionSchema`, `EvalResultSchema`, and
      `ReleasePointerSchema`.
- [ ] Capture current G3R/G4A/G4B artifact hashes and prove they decode before
      adding optional learning fields.
- [ ] Confirm fixture partitions and D5 thresholds are frozen before candidate
      behavior exists.

### Test-first checklist

- [ ] Add one minimal valid fixture for every new persisted/cross-package
      artifact.
- [ ] Reject trace without task spec, frozen Context identity, ordered
      trajectory refs, outcome/feedback/error/gap, active release/config,
      runtime identity, costs/side effects, redaction metadata, or valid seal.
- [ ] Reject raw sensitive payload in a reference-only trace step.
- [ ] Reject duplicated scopes, steps, evidence, cases, arms, transitions, or
      release IDs.
- [ ] Reject obsolete `transcript_baseline`, `fts_baseline`, and `approved`
      vocabulary.
- [ ] Accept only `no_candidate`, `current`, and `candidate`.
- [ ] Accept only the legal candidate state vocabulary.
- [ ] Require target/payload, base release, slot, expected improvement,
      protected invariants, evaluation contract, and rollback identity.
- [ ] Reject executable/unknown payload and unsupported release capability.
- [ ] Require all three evaluation partitions, at least three cases per
      partition, and three independent canary cases.
- [ ] Reject partition/path/hash/visibility mismatch and post-freeze mutation.
- [ ] Reject canary case/oracle access before `approved_for_canary`.
- [ ] Require common identity equality across arms.
- [ ] Require critical failures and measurement dimensions to remain separate.
- [ ] Require canary authorization to bind evaluation plus the sealed canary
      manifest without a future receipt.
- [ ] Require post-canary release/rollback approvals and release/monitor/
      control/rollback envelopes to bind exact upstream receipts/hashes.
- [ ] Prove old artifacts without optional learning metadata preserve hashes.
- [ ] Prove D5 thresholds and accepted G3R/G4A/G4B/vector-free identity are
      present in the manifest.

### Implementation checklist

- [ ] Replace provisional trace/candidate/evaluation/release schemas with
      strict M5 artifacts.
- [ ] Add ordered trace-step/redaction and evidence-reference schemas.
- [ ] Add release capability, slot, target/payload, state-transition, common
      run identity, partition seal/visibility, evaluation receipt, canary
      authorization, post-canary approval, release version/pointer, monitor,
      control, rollback, and G5 schemas.
- [ ] Extend effective configuration/receipts with optional active learning
      release identity while preserving absence compatibility.
- [ ] Add exact learning MCP input contracts and approval-binding fields.
- [ ] Export all public schemas/builders/types from one owner.
- [ ] Freeze G5 evaluation/canary cases, thresholds, and manifest hashes.
- [ ] Keep holdout/transfer expected values in protected files referenced by
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

- [ ] Every invalid fixture fails for its declared boundary.
- [ ] All cases/partitions/thresholds/baselines are frozen and hashed.
- [ ] Existing decision artifact compatibility is exact.
- [ ] `trellis-check` has no unresolved finding for U1.
- [ ] Create only the U1 commit.

**Rollback point:** revert U1; no migration, learning package, or runtime
effect exists.

## 4. U2 — SQLite learning ledger, state, and frontiers

**Requirements:** R16-R20; F4.

**Depends on:** U1.

**Files:**

- `migrations/0014-learning-lab.sql`
- `packages/storage-sqlite/src/learning-repository.ts`
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

- [ ] Load `trellis-before-dev`.
- [ ] Read backend database, error, logging, quality, cross-layer, and reuse
      specs.
- [ ] Characterize migration upgrade/reopen, writer-worker serialization,
      append-only triggers, idempotency replay, approval consumption, and
      transaction rollback.
- [ ] Map every new table to its owning contract and public storage operation.
- [ ] Confirm no migration 0014 exists and migration numbering is contiguous.

### Test-first checklist

- [ ] Upgrade a current M4B database without changing old rows/hashes/counts
      except additive health fields.
- [ ] Append/re-read a complete trace and ordered evidence references.
- [ ] Append/re-read immutable candidate and ordered trace links.
- [ ] Append a legal transition sequence and derive current state.
- [ ] Reject illegal/backward/duplicate/stale transition.
- [ ] Persist partition seals, runs, arm results, contamination events, and
      evaluation receipts.
- [ ] Persist bounded canary, release version, active pointer, monitor,
      control, and rollback records.
- [ ] Enforce one active pointer per canonical slot and monotonic pointer
      revision.
- [ ] Enforce one control row/epoch per principal and expected-frontier CAS.
- [ ] Replay same idempotency key/hash and conflict on changed hash.
- [ ] Reject foreign principal/scope, wrong base/slot/target, reused approval,
      and mismatched receipt chain.
- [ ] Inject failure before/after every pointer, control, transition, approval,
      idempotency, canonical effect, outbox, and receipt write.
- [ ] Reopen after each failure and assert entire old or entire new state.
- [ ] Prove immutable rows cannot update/delete.
- [ ] Prove worker protocol rejects unknown/malformed request/response.
- [ ] Tombstone/purge a referenced memory and prove the learning target becomes
      unresolvable.
- [ ] Scan SQLite/WAL/diagnostics for marker content not authorized for
      learning retention.
- [ ] Carry learning release/control frontier through health and restore
      refusal checks.

### Implementation checklist

- [ ] Add typed tables, checks, unique keys, foreign keys, indexes, and
      append-only/guard triggers.
- [ ] Add immutable trace/candidate/transition/evaluation/canary/release/
      monitor/rollback persistence.
- [ ] Add guarded active pointer and learning control CAS.
- [ ] Couple effects, idempotency, approval consumption, transition, and
      receipt in one immediate transaction.
- [ ] Add strict protocol schemas and decoded worker/client operations.
- [ ] Extend health/count/frontier output without leaking content.
- [ ] Integrate target invalidation with revoke/tombstone/purge.
- [ ] Extend restore validation to refuse a snapshot behind required learning
      release/control frontiers.
- [ ] Export only the public storage surface.

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

- [ ] Upgrade/reopen, worker decoding, CAS, append-only, idempotency, approval,
      crash, purge, and restore tests pass.
- [ ] Learning storage contains no duplicated memory/procedure content.
- [ ] `trellis-check` has no unresolved U2 finding.
- [ ] Create only the U2 commit.

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

- [ ] Load `trellis-before-dev`.
- [ ] Confirm package dependency direction: contracts + public storage port
      only; no driver, MCP SDK, graph/vector, or model dependency.
- [ ] Search existing canonical seal, governance admission, evidence lookup,
      Context lookup, scope normalization, and stop-reason patterns.
- [ ] Freeze deterministic qualification rules; do not add an LLM heuristic.

### Test-first checklist

- [ ] Complete task evidence creates one valid sealed trace.
- [ ] Same ordered input replays one trace; changed input under same key
      conflicts.
- [ ] Reordered steps change the trace seal.
- [ ] Positive, negative, and conflicting observations remain distinct.
- [ ] Missing task/Context/config/outcome/failure/provenance emits stop and zero
      candidate.
- [ ] Paused control epoch emits stop and zero candidate.
- [ ] Foreign/purged/inaccessible evidence emits stop and zero candidate.
- [ ] Sensitive raw content is referenced/redacted and marker-free in learning
      rows/errors.
- [ ] Smallest candidate ordering chooses memory, procedure, then narrowing
      retrieval policy.
- [ ] Prompt/Core/Scenario is evaluation-only.
- [ ] Skill/code/model candidate is unsupported.
- [ ] Candidate without exact base/slot/target/invariants/evaluation/rollback
      is rejected.
- [ ] Proposal leaves active pointer, normal Context, and canonical memory
      byte-identical.

### Implementation checklist

- [ ] Implement trace completeness, evidence/Context resolution, redaction,
      canonical sealing, persistence, and idempotent replay.
- [ ] Preflight idempotent replay by normalized request identity before
      rereading mutable evidence, control, policy, or target state.
- [ ] Implement typed stop reasons without raw content.
- [ ] Implement deterministic candidate qualification and capability.
- [ ] Bind trace set, base release, slot, target/payload, improvement,
      invariants, risk, authority, evaluation, and rollback.
- [ ] Persist only inactive immutable candidates.
- [ ] Export the minimal public Learning Lab surface.
- [ ] Add the package to the runtime build before its first consumer.

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

- [ ] Complete evidence creates one replayable inactive candidate.
- [ ] Every incomplete/unsafe path records a stop with zero publication.
- [ ] Package dependency boundary is clean.
- [ ] `trellis-check` has no unresolved U3 finding.
- [ ] Create only the U3 commit.

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
- `tests/learning/three-arm-evaluation.test.ts`
- `tests/security/learning-partition-isolation.test.ts`
- `tests/replay/learning-negative-transfer.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Characterize G3/G4A/G4B replay common-identity and separated-score
      helpers.
- [ ] Map file/module boundaries so proposal/calibration code cannot import
      holdout/transfer expected bodies.
- [ ] Confirm isolated arm storage/runtime reset strategy.

### Test-first checklist

- [ ] Run all three arms for every calibration/holdout/transfer case.
- [ ] Assert every common-identity field is exact across arms.
- [ ] Assert only candidate/release application differs.
- [ ] Reject missing/duplicate arm and incomplete case.
- [ ] Reject changed input, Context, reader, tool, budget, runtime, policy,
      lock, scorer, seed, threshold, environment, or baseline decision.
- [ ] Reject candidate/fixture mutation after freeze.
- [ ] Detect holdout/transfer expected-output access by proposal/calibration.
- [ ] Record contamination and invalidate the run.
- [ ] Report task, error, negative transfer, Context/tokens, latency, side
      effects, scope/privacy/governance, and critical failures separately.
- [ ] Reject any evaluation side effect on normal pointer/canonical memory.
- [ ] Reject calibration-only gain with holdout/transfer harm.
- [ ] Replay identical identity to identical logical results/hashes.
- [ ] Give changed identity a new run and prevent approval reuse.

### Implementation checklist

- [ ] Implement partition descriptor/visibility loader and sealed scorer
      boundary.
- [ ] Freeze common identity before arm execution.
- [ ] Execute arms from isolated equivalent state.
- [ ] Collect strict per-case result contracts.
- [ ] Evaluate D5 conjunctive thresholds without a compensating aggregate.
- [ ] Persist per-case results, contamination, invalidation, and evaluation
      receipt.
- [ ] Expose content-free logical result helpers for G5 scripts.

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

- [ ] Every case has three comparable arms or a typed invalidation.
- [ ] Leakage/drift/side-effect protection is executable.
- [ ] Harmful/overfit candidates cannot pass.
- [ ] `trellis-check` has no unresolved U4 finding.
- [ ] Create only the U4 commit.

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

- [ ] Load `trellis-before-dev`.
- [ ] Characterize current grant parsing, manifest hashing, exact matching,
      time checks, confirm-unchanged, and consumption behavior.
- [ ] Search every exhaustive tool/approval mapping before extending it.
- [ ] Freeze three independent canary cases before candidate behavior, keep
      them inaccessible until approval, and freeze one exposure per case plus
      a ten-minute deadline and promote/abort rules.
- [ ] Freeze distinct canary-authorization and post-canary release-approval
      identities so no grant binds a receipt that does not exist yet.

### Test-first checklist

- [ ] Replay the one legal state path to release/rollback.
- [ ] Reject every skip, backward move, stale expected transition, and
      terminal-state transition.
- [ ] Same transition idempotency/hash replays; changed hash conflicts.
- [ ] Approve only complete valid evaluation with all D5 offline rules.
- [ ] Reject evaluation-only/unsupported capability before canary.
- [ ] Reject missing/expired/changed/wrong principal/tool/scope/candidate/
      slot/base/evaluation/request/manifest canary authorization.
- [ ] Reject any canary authorization that attempts to bind a precomputed
      terminal canary receipt.
- [ ] Reject missing/expired/changed/wrong principal/tool/scope/candidate/
      slot/base/evaluation/canary-receipt/pointer/request/manifest
      post-canary release or rollback approval.
- [ ] Prove proposer/evaluator evidence cannot authorize release.
- [ ] Prove canary authorization is consumed exactly once when canary starts.
- [ ] Prove one post-canary approval is consumed once and the same release or
      rollback request replays afterward.
- [ ] Preserve old non-learning approval grants/hashes.
- [ ] Canary uses exact stable/current comparator and frozen cases.
- [ ] Canary rejects early case/oracle visibility.
- [ ] Canary passes only inside exposure/time/metric bounds.
- [ ] Canary aborts/freezes on critical regression, drift, pause, timeout,
      missing stable, or exposure overflow.
- [ ] Canary never changes the normal active pointer.

### Implementation checklist

- [ ] Implement one exhaustive state reducer and transition validator.
- [ ] Persist state-changing transitions through storage CAS.
- [ ] Extend approval contracts/registry binding only for learning tools, with
      separate canary-authorization and post-canary approval schemas.
- [ ] Confirm the canary manifest at canary start and atomically consume its
      authorization.
- [ ] Commit the canary state transition, authorization, terminal run,
      receipt, and idempotency result in the same SQLite transaction.
- [ ] Confirm the effect manifest at release/rollback boundary and prepare
      exact post-canary approval consumption data.
- [ ] Implement frozen bounded canary runner and durable terminal receipt.
- [ ] Keep canary execution candidate-only.

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

- [ ] Legal state replay, illegal-transition rejection, exact authority, and
      bounded canary pass.
- [ ] Non-learning approval behavior is unchanged.
- [ ] `trellis-check` has no unresolved U5 finding.
- [ ] Create only the U5 commit.

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
- `packages/contracts/src/projections.ts`
- `packages/contracts/src/receipts.ts`
- `tests/integration/learning-release.integration.test.ts`
- `tests/governance/learning-memory-release.integration.test.ts`
- `tests/recovery/learning-release-rollback.recovery.test.ts`
- `tests/replay/learning-release-pointer.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Characterize base Context output/hash with no active learning release.
- [ ] Characterize canonical memory revision creation, outbox coupling,
      frozen recall replay, and transaction guards.
- [ ] Decide the smallest private governance transaction adapter and document
      any plan-consistent file adjustment before editing.
- [ ] Freeze crash-injection boundaries.

### Test-first checklist

- [ ] No active pointer equals accepted vector-free baseline.
- [ ] Exact scope-set slot normalizes order deterministically.
- [ ] Subset/superset/foreign scope does not resolve the release.
- [ ] Retrieval candidate may remove lanes/lower limits.
- [ ] Reject adding lanes, raising limits, enabling graph/vector, or changing
      ACL, sensitivity, mandatory-exclusion, hard-filter, or governance
      behavior.
- [ ] Seal resolved release/config hash into recall/Context receipts.
- [ ] Release memory/procedure from canonical candidate without copying
      content or updating immutable revision.
- [ ] Commit canonical successor, status/admission, outbox, release version,
      pointer, transition, approval, idempotency, and receipt atomically.
- [ ] Inject failure at each write and observe old-or-new state after reopen.
- [ ] Two concurrent release/rollback requests from one pointer yield one
      winner and one conflict.
- [ ] Pause and release serialize on the observed control epoch: pause-first
      makes release stale; release-first makes pause record
      `RELEASE_COMPLETED_BEFORE_PAUSE` and leaves rollback explicit.
- [ ] New request after release uses the new pointer.
- [ ] Old request ID replays original frozen Context.
- [ ] Rollback restores exact named prior release pointer and prior
      behavior/config hash on a new request.
- [ ] Reject rollback to revoked/tombstoned/purged/cross-scope/changed target.
- [ ] Approval is consumed iff effect exists after crash.
- [ ] Normal runtime starts and serves without an evaluator/candidate process.

### Implementation checklist

- [ ] Implement release/rollback orchestration and exact command contracts.
- [ ] Implement private atomic storage transaction composition.
- [ ] Implement immutable release version and active-pointer CAS.
- [ ] Implement retrieval-policy release resolver and narrow-only
      intersection.
- [ ] Keep ACL, sensitivity, mandatory-exclusion, and other safety filters
      outside learned policy payloads and active under base fallback.
- [ ] Implement canonical memory/procedure append-only release adapter.
- [ ] Implement rollback version, target validation, inverse canonical/
      projection effects, and no-resurrection guard.
- [ ] Include active release identity in effective config and receipts.
- [ ] Preserve old frozen request replay and base behavior.

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

- [ ] Release/rollback atomicity and no-resurrection pass.
- [ ] Learned policy only narrows; base behavior remains exact without a
      pointer.
- [ ] Canonical memory/procedure content has one authority.
- [ ] `trellis-check` has no unresolved U6 finding.
- [ ] Create only the U6 commit.

**Rollback point:** restore base pointer/disable release resolution, then
revert U6; evaluated candidate history remains inactive.

## 9. U7 — MCP feedback and learning controls

**Requirements:** R16-R20; F4; AE7.

**Depends on:** U6.

**Files:**

- `packages/contracts/src/tool-inputs.ts`
- `packages/contracts/src/mcp.ts`
- `packages/mcp-server/src/index.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/storage-sqlite/src/client.ts`
- `packages/storage-sqlite/src/protocol.ts`
- `tests/mcp/learning-controls.integration.test.ts`
- `tests/integration/learning-pause-runtime-continuity.integration.test.ts`
- `tests/recovery/learning-pause-resume.recovery.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Search every MemoryToolName, safety-class, metadata, annotation,
      registration, approval, and runtime exhaustive mapping.
- [ ] Characterize ordinary search/get/Context/mutation while no learning
      control handler exists.
- [ ] Freeze control epoch/frontier identity and in-flight policy.

### Test-first checklist

- [ ] `memory_feedback` stores governed evidence/trace input and has no release
      effect.
- [ ] Pause with exact trusted request advances one control epoch and receipt.
- [ ] Pause replay is idempotent; changed request conflicts.
- [ ] While paused, search/get/Context compile succeeds.
- [ ] While paused, one authorized ordinary memory mutation succeeds.
- [ ] While paused, new candidate/evaluation/canary/release transition stops.
- [ ] Running evaluation may write terminal receipt but cannot approve/publish.
- [ ] Running canary freezes/aborts and cannot publish.
- [ ] Pause/release concurrency follows the SQLite control-epoch ordering and
      emits the specified release-before-pause reason when applicable.
- [ ] Resume succeeds only with exact expected epoch/frontier and unchanged
      runtime/config/corpus identity.
- [ ] Drift forces reevaluation or explicit abandonment.
- [ ] Release/rollback rejects wrong actor/scope/safety/expected pointer/
      approval/evaluation/canary.
- [ ] Every tool has one exact safety class and correct annotations.
- [ ] Learning inspection resource contains content-free status/IDs/hashes.
- [ ] Restart preserves pause/control, active pointer, and frozen work.
- [ ] Error/resource/log output omits raw learning/evidence/Context content.

### Implementation checklist

- [ ] Complete input schemas and runtime handlers for the five M5 tools.
- [ ] Register exhaustive metadata and MCP tools.
- [ ] Implement content-free inspection resource.
- [ ] Implement pause/resume CAS, idempotency, approval, receipt, and frontier
      revalidation.
- [ ] Keep core memory paths independent of learning pause.
- [ ] Map known failures to stable governed response codes.

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

- [ ] All reserved M5 tool names have implementation/metadata parity.
- [ ] Pause/resume is durable without core runtime degradation.
- [ ] Every effect-bearing call returns durable evidence.
- [ ] `trellis-check` has no unresolved U7 finding.
- [ ] Create only the U7 commit.

**Rollback point:** unregister M5 handlers and keep learning publication
disabled; base MCP/runtime continues.

## 10. U8 — G5 evidence capture and verification

**Requirements:** R16-R20; F4; AE6/AE7.

**Depends on:** U4, U7.

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

- [ ] Worktree is clean on committed U7.
- [ ] Record tested commit/tree and lockfile hash before executing.
- [ ] Record migration, runtime, platform, G3R/G4A/G4B, retrieval config,
      fixture, partition, threshold, scorer, and seed identities.
- [ ] Confirm graph/vector remain disabled/default-off.
- [ ] Confirm candidate was frozen before holdout/transfer execution.

### Harness checklist

- [ ] Run one complete safe narrowing retrieval-policy path.
- [ ] Run one harmful calibration-only/negative-transfer path.
- [ ] Prove safe path has all three arms and D5 per-partition deltas.
- [ ] Prove harmful path is rejected with zero pointer change.
- [ ] Exercise exact approval and single consumption.
- [ ] Exercise separate canary authorization and post-canary release approval;
      reject circular/precomputed canary-receipt binding.
- [ ] Exercise bounded canary success and forced abort.
- [ ] Prove exactly three independent canary exposures, no early visibility,
      and completion inside the frozen deadline.
- [ ] Exercise release, monitor success/breach, pause, resume, rollback, and
      no-resurrection.
- [ ] Replay each independent canary input exactly once through the active
      pointer for monitoring; prove a mismatch/breach blocks G5 until an
      authorized rollback receipt restores the safe pointer.
- [ ] Exercise crash recovery at pointer/receipt/approval boundaries.
- [ ] Exercise ordinary runtime continuity while paused and after NO-GO
      fallback.
- [ ] Measure task units, errors, negative transfer, Context/tokens, latency,
      side effects, governance, privacy, release, and rollback separately.
- [ ] Capture limitations and synthetic-evidence boundary.

### Evidence verifier checklist

- [ ] Recompute source commit/tree and lockfile hash.
- [ ] Recompute every migration, fixture, partition, threshold, scorer,
      report, approval, canary, release, monitor, rollback, and decision-input
      hash.
- [ ] Verify G3R/G4A/G4B decisions and vector-free configuration.
- [ ] Verify candidate/common identity and all three arms.
- [ ] Verify D5 rules conjunctively.
- [ ] Verify release/rollback receipt chain and exact prior pointer.
- [ ] Verify canary authorization and post-canary release approval are distinct
      exact single-use chains.
- [ ] Verify monitor replay consumed the active pointer and any breach remained
      a G5 blocker until authorized rollback.
- [ ] Verify focused/full quality outputs and code-review result.
- [ ] Fail on missing/tampered/extra unbound evidence.

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

- [ ] Full repository gates pass on the tested implementation.
- [ ] Replay/canary/resource reports and manifest are generated from the
      committed tree.
- [ ] Verifier reports every hard rule and passes artifact integrity.
- [ ] Reports make no production/M6 claim.
- [ ] Create only the U8 evidence commit; do not include the G5 decision.

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

- [ ] Read `docs/evaluations/g5-verification-report.json`.
- [ ] Identify the first false hard rule, if any.
- [ ] Confirm tested implementation commit and evidence commit are immutable.
- [ ] Confirm active/base release and exact rollback target.
- [ ] Confirm graph/vector decisions are unchanged.
- [ ] Confirm full quality/review evidence applies to the tested tree.
- [ ] Record exactly one result:
  - [ ] GO only if every hard rule is true.
  - [ ] NO-GO on any false/missing rule.
- [ ] On GO, activate only the exact tested release and preserve pause/
      rollback.
- [ ] On NO-GO, retain/restore base pointer and prove candidate-only/core
      runtime continuity.
- [ ] Record limitations and synthetic-evidence boundary.
- [ ] Update ADR 0005.
- [ ] Update parent G5 row with exact tested implementation and decision path.
- [ ] Mark this plan decision-complete without rewriting historical scope.
- [ ] Mark U1-U9 checklist results honestly.

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

- [ ] One verifier-backed G5 outcome exists.
- [ ] Parent/ADR/plan/task metadata agree on tested/evidence commits, active
      release, fallback, and limitations.
- [ ] M6 remains pending and starts from the recorded M5 baseline.
- [ ] Create only the U9 decision commit.

**Rollback point:** revert the U9 documentation/metadata commit; U8 evidence
and tested implementation remain immutable.

## 12. Closure — archive and journal as separate tasks

After U9 is committed:

### Archive task

- [ ] Re-run `task.py validate`.
- [ ] Confirm no unchecked required implementation item remains.
- [ ] Archive the M5 child with Trellis.
- [ ] Confirm the parent child link resolves to the archive.
- [ ] Create only the archive commit.

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
