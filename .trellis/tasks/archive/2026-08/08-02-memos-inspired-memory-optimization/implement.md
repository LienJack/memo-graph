# Implementation plan

## 0. Execution gates

- Do not start until the user approves the completed PRD/design/plan and
  `task.py start` changes the task to `in_progress`.
- Use the Codex inline workflow: read this task, research, and backend specs;
  implement in the main session; run `trellis-check` after code changes.
- Keep unrelated user changes intact.
- Do not change the historical top-level G6 U7/U8 artifact bytes.
- Do not sign or install a G6 release control.

## 1. Baseline freeze and failing contracts

- [x] Record current branch, HEAD, lockfile hash, migration-set hash, Node/pnpm
      versions, and clean/dirty state in the task research directory.
- [x] Record raw hashes for every legacy top-level G6 evidence/decision artifact
      so final validation can prove immutability.
- [x] Add failing fixture tests that require a versioned run layout, reject
      cross-run/legacy path mixing, and reject any direct proof with more than
      one obligation or a reused proof selector.
- [x] Add failing Runbook tests that require actual CLI invocation and strict
      typed output instead of constant booleans.
- [x] Add failing contract tests for the new ingest tool, all three item
      variants, authority mapping, size bounds, secret rejection, and strict
      unknown-field rejection.

### Baseline checks

```bash
pnpm test:contract
pnpm test:fixtures
git diff --check
```

Rollback point: tests and task artifacts only; no runtime behavior changed.

## 2. G6 v2 run layout and proof contracts

- [x] Add a strict G6 run-layout contract with a full candidate commit, exact
      versioned output root, exact artifact set, and no traversal/alias support.
- [x] Refactor G6 common helpers to accept an explicit run context while
      retaining a read-only legacy verification path where useful.
- [x] Make evidence discovery relative to the selected run directory instead
      of a global `g6-*` glob.
- [x] Version the rerun fixture schema and model executable fault/acceptance
      proofs as one obligation per selector.
- [x] Validate exact coverage of all 43 fault points and 16 acceptance Oracles,
      unique proof IDs, unique obligations, unique selectors, and test-only
      relative paths.
- [x] Keep aggregate proof reduction blocked and add positive/negative fixture
      regressions for the v2 model.
- [x] Update runner declarations and package scripts to require an explicit
      candidate-bound run for new evidence; prevent accidental overwrite of an
      existing run directory.

### Focused checks

```bash
pnpm test:fixtures
pnpm typecheck
pnpm lint
```

Rollback point: revert the additive v2 layout/proof model; legacy reports are
untouched.

## 3. Direct fault and acceptance proof implementation

- [x] Inventory every current fault seam and map it to exactly one G6 proof
      case; do not infer coverage from a group label.
- [x] Extract reusable setup helpers without merging proof outcomes.
- [x] Split or parameterize recovery tests into uniquely selectable
      `G6 fault:<fault_point>` cases for all 43 points.
- [x] Split each `M6_AE1` through `M6_AE8` into distinct success and failure
      Oracle proof cases.
- [x] Assert seam-specific old-or-new canonical state, receipt/frontier
      agreement, restart/retry idempotency, no resurrection, and typed
      readiness as applicable.
- [x] Update the v2 fixture selectors and run the fault runner; inspect any
      genuine failures instead of changing the reducer or weakening an Oracle.
- [x] Add verifier tamper cases for missing, duplicate, aggregate, ambiguous,
      fail, blocked, and unbound proof results.

### Focused checks

```bash
pnpm build:runtime
pnpm vitest run tests/fixtures/g6.fixture.test.ts
pnpm test:recovery
pnpm test:integration
pnpm g6:faults -- --run-root <temporary-run-root>
```

Gate A: all 43 fault obligations and all 16 acceptance obligations are direct
and pass before EvidenceAdapter runtime work begins. Temporary/prequalification
output is not committed as final evidence.

Rollback point: revert only proof-case refactoring; do not alter the legacy U7
bundle.

## 4. Shared operator output schemas

- [x] Search and reuse existing operational, encryption, purge, backup,
      receipt, and G6 schemas before adding new definitions.
- [x] Add strict shared schemas only for operator outputs that currently have
      local structural types or unvalidated object literals.
- [x] Export inferred types from the owning contract module and root index.
- [x] Make every relevant operator command parse its result through the shared
      schema before JSON/human rendering.
- [x] Update all exhaustive output/exit mappings and contract snapshots.
- [x] Add positive, unknown-field, missing-field, invalid-state, and
      schema/exit-class mismatch tests.

### Focused checks

```bash
pnpm test:contract
pnpm vitest run tests/integration/operator-cli.integration.test.ts
pnpm typecheck
pnpm lint
```

Rollback point: restore local return construction; no persisted data changes.

## 5. Direct Runbook automation harness

- [x] Build a temporary private fixture root for the ten frozen operator paths.
- [x] Materialize concrete argv from frozen automation without accepting shell
      strings or unresolved placeholders.
- [x] Spawn the built operator CLI entry point for every step.
- [x] Treat the declared operator exit class as part of the typed contract; a
      valid operator-action-required result is not a process failure.
- [x] Parse JSON stdout with the step's shared schema and assert
      command-specific invariants.
- [x] Scan captured streams and fixture artifacts for forbidden markers, but
      persist only content-free result metadata.
- [x] Derive `grammar_verified`, `proof_test_passed`,
      `direct_automation_observed`, and `typed_result_verified` from observed
      execution; remove constant `false` placeholders.
- [x] Add timeout, unexpected exit, malformed JSON, schema drift, marker leak,
      and fixture-setup failure tests.
- [x] Run all ten paths and require the Runbook report to pass before adapter
      implementation.

### Focused checks

```bash
pnpm build:runtime
pnpm vitest run tests/integration/operator-cli.integration.test.ts
pnpm vitest run tests/integration/operator-destructive-confirmation.integration.test.ts
pnpm g6:runbooks -- --run-root <temporary-run-root>
pnpm verify:g6 -- --run-root <temporary-run-root>
```

Gate B: every frozen Runbook step is directly observed and typed. The verifier
must fail if any boolean is synthetic or any output bypasses its schema.

Rollback point: remove the additive direct runner and fixture builder; legacy
Runbook evidence remains unchanged.

## 6. EvidenceAdapter contracts and pure package

- [x] Add `memory_evidence_ingest` to the tool enum and exhaustive safety map as
      `proposal`.
- [x] Define strict discriminated schemas for conversation turn, tool result,
      text-file body, ingest request, and adaptation result.
- [x] Enforce exact scope membership, non-secret sensitivity, per-item and
      aggregate UTF-8 size bounds, ordered non-empty items, and supported text
      media types.
- [x] Create `packages/evidence-adapter` with only contracts as a runtime
      dependency.
- [x] Implement the pure `fast_l0` transform using existing canonical JSON/hash
      helpers, domain-separated full-digest identifiers, ordered sequences,
      explicit authority mapping, and episode sealing.
- [x] Parse the transform output through the owning schema before returning it.
- [x] Add deterministic golden tests for all variants, mixed ordering, Unicode,
      timestamp bounds, identity stability, content changes, and invalid input.
- [x] Update workspace build order without adding third-party dependencies.

### Focused checks

```bash
pnpm --filter @memo-graph/contracts build
pnpm --filter @memo-graph/evidence-adapter build
pnpm test:contract
pnpm typecheck
pnpm lint
```

Rollback point: remove the additive package/contracts/tool name; no ledger
migration or canonical data rewrite exists.

## 7. Kernel and MCP vertical slice

- [x] Refactor the existing episode commit implementation into one private
      canonical commit helper without changing direct commit behavior.
- [x] Implement `memoryEvidenceIngest`: strict decode, principal authorization,
      pure adaptation, mapped-authority authorization, shared commit, existing
      FTS drain, and content-free response metadata.
- [x] Register the new MCP tool with the shared input/output schemas and
      proposal annotations.
- [x] Update runtime interfaces, discovery snapshots, tool count assertions,
      contract resources, and explicit-loop documentation.
- [x] Add kernel tests for each variant, mixed batches, direct-commit
      compatibility, same-key replay, changed-key conflict, scope denial,
      authority denial, and secret/oversize rejection.
- [x] Add storage/governance assertions proving exactly one episode plus L0
      evidence and zero candidates, governed revisions, admissions, learning
      releases, or release-pointer effects.
- [x] Add official MCP stdio restart coverage: ingest, stop, reopen the same
      ledger, search/explain/compile, and validate receipt/hash lineage.
- [x] Add diagnostics/security marker tests proving input bodies are absent from
      logs, errors, and evidence reports.

### Focused checks

```bash
pnpm test:mcp
pnpm test:integration
pnpm test:governance
pnpm test:storage
pnpm test:recovery
```

Gate C: the adapter is useful end to end but cannot produce an admitted or
published long-term memory.

Rollback point: remove the additive MCP method/registration and package. Any L0
evidence already written remains valid canonical evidence created by the
unchanged commit path.

## 8. Full review and candidate freeze

- [x] Run `trellis-check` against the complete diff and resolve every verified
      correctness, authority, security, reliability, and testing finding.
- [x] Run code-reuse and cross-layer audits for schemas, safety maps, output
      parsers, tool discovery, and report consumers.
- [x] Update backend specs only for durable new contracts/patterns.
- [x] Run the full repository gate under the pinned Node runtime.
- [x] Confirm legacy G6 artifact hashes still match the baseline.
- [x] Confirm graph/vector/automatic publication flags remain false and secret
      admission has no new installed control.
- [x] Commit the clean combined implementation candidate. Record its full
      commit/tree/runtime-input identity.

### Full candidate gate

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
git status --short
```

Rollback point: revert the candidate commit. No evidence run has yet been
declared current.

## 9. Fresh immutable G6 evidence for the combined candidate

- [x] Create a new run directory named by the exact clean candidate commit.
- [x] Run fault, resource, Runbook, security, supply-chain, reproducibility,
      runtime-identity, and code-review evidence against that candidate.
- [x] Run the versioned verifier with decision artifacts absent.
- [x] Require fault and Runbook report states to be `pass`. If another hard
      rule is false/blocked, preserve its first-non-pass result honestly.
- [x] Confirm the bundle is content-free, exact-path-bound, candidate-bound,
      and excludes all legacy U7/U8 files.
- [x] Write a handoff that distinguishes evidence eligibility from production
      release authority and states that secret admission remains disabled.
- [x] Commit the new evidence directory as an immutable evidence commit.
- [x] Re-run verification without changing source. Any source fix requires a
      new candidate commit and a new run directory, never an in-place rewrite.

### Evidence commands

```bash
pnpm g6:faults -- --run-root docs/evaluations/g6-runs/<full-commit>
pnpm g6:resources -- --run-root docs/evaluations/g6-runs/<full-commit>
pnpm g6:runbooks -- --run-root docs/evaluations/g6-runs/<full-commit>
pnpm g6:bootstrap -- --run-root docs/evaluations/g6-runs/<full-commit>
pnpm g6:manifest -- --run-root docs/evaluations/g6-runs/<full-commit>
pnpm verify:g6 -- --run-root docs/evaluations/g6-runs/<full-commit>
```

No `g6:release-control` command is run in this task.

## 10. Final validation and delivery

- [x] Verify the evidence commit contains only the new versioned bundle and
      allowed documentation/task updates.
- [x] Re-run focused adapter, G6 fixture, Runbook, governance, recovery, and
      security suites from the final tree.
- [x] Re-run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
- [x] Confirm legacy G6 hashes, current `NO-GO` control, disabled secret
      admission, and G4A/G4B `NO-GO` boundaries are unchanged.
- [x] Record the implementation candidate, evidence commit, final verifier
      state, known limitations, and deferred MemOS-inspired work.
- [x] Archive the Trellis task only after commits and verification are complete.

## 11. Deferred follow-up order

After this task, separately plan and evaluate:

1. projection worker bounded retry, poison quarantine, operator re-drive, and
   content-free task metrics;
2. receipt/revision-bound natural-language CorrectionPlanner dry runs;
3. configuration-only MemoryProfile;
4. candidate-only fine/LLM, multimodal, skill, or reflection extraction.

None of these follow-ups is authorized by approval of this task.
