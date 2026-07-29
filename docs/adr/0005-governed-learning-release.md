# ADR 0005: Governed learning release

- Status: Accepted for the exact G5-tested local synthetic release path
- Date: 2026-07-30
- Gate: G5

## Decision

Adopt the governed M5 Learning Lab boundary for one exact-scope,
narrow-only retrieval-policy release. A learning candidate may affect new
requests only after immutable evidence, protected three-arm evaluation,
separate exact canary authorization, a bounded hidden canary, a distinct
post-canary release approval, and an atomic SQLite pointer transition.

Automatic publication remains disabled. SQLite remains authoritative.
Learning orchestration cannot grant eligibility, widen the configured
operator policy, enable graph/vector, rewrite historical Context, or bypass
canonical lifecycle and deletion controls.

The terminal decision receipt is
[`g5-decision.md`](../evaluations/g5-decision.md).

## Accepted identity

- Tested implementation:
  `91d810efe17632e64f5e9a3ddae81f8e9f0b9985`
- Evidence commit:
  `b9c0907745cedf3315d7ab3f42a39c9afb8790eb`
- G5 manifest:
  `sha256:12fe4d89de233dbe43ae3e1c416ca58a1e07684ed9602085416e2e40db6c6fac`
- Release slot:
  `sha256:634ed733beb2ce00f30f9da0297e2f9dfd1f135ac7a8c10e6962dca144bd109f`
- Qualified candidate: `candidate_storage_1`
- Qualified release:
  `release:a8f7214a0c8a8db3b5f2515649b06c0ffc855ab68`
- Exact prior release and rollback target: `null`

Any change to executable identity, lockfile, migrations, corpus, partitions,
thresholds, scorer, seed, release slot, candidate type, scope, retrieval
topology, graph/vector decisions, or authority chain invalidates this
decision for the changed configuration.

## Why

The frozen safe candidate passed every calibration, holdout, and transfer
rule against both `no_candidate` and `current` under a shared execution
identity. A harmful calibration-only candidate was rejected without moving
the release pointer.

The release path also proved:

- canary cases remained hidden before exact authorization;
- precomputed post-canary approval was rejected;
- three independent canary exposures completed inside the bound;
- a forced timeout aborted terminally;
- release and approval replay were single-effect;
- the active pointer was replayed through all monitor inputs;
- a forced monitor mismatch blocked G5 until exact authorized rollback;
- pause blocked learning transitions without disabling normal recall;
- rollback while paused restored the named prior pointer;
- release replay after rollback could not resurrect the learned release.

The independent verifier found no false hard rule and the required code review
had zero unresolved P0/P1 findings.

## Authority and rollback boundary

- Candidate generation, evaluation, and canary do not move the active pointer.
- Canary authorization and release approval are separate exact single-use
  chains.
- Publication moves a versioned release pointer in the same SQLite
  transaction as transition, approval consumption, idempotency, and receipt.
- Learning pause is a principal-local control frontier; ordinary governed
  recall and authorized memory mutation remain available.
- Monitor breach is a release blocker until an authorized rollback receipt
  restores the exact prior pointer.
- Rollback is append-only and may not resurrect invalidated canonical state.

The synthetic evidence path deliberately rolled the learned release back to
the base `null` pointer after the monitor-breach drill. G5 GO accepts both the
exact tested release and its exact recovery path; it does not claim a
production deployment.

## Consequences

- M5 is complete with a verifier-backed G5 `GO`.
- Only the tested narrow retrieval-policy capability is release-capable.
- Prompt, CoreProjection, ScenarioPattern, Skill, code, model-parameter, and
  broader policy publication remain unsupported.
- Graph remains disabled under G4A `NO-GO`.
- Vector remains disabled under G4B `NO-GO`.
- Operators retain pause, resume, monitor, and exact rollback controls.
- M6 must carry the release/control/tombstone frontiers through backup,
  restore, migration, disk-pressure, observability, and fault drills.

This ADR is limited to deterministic local synthetic evidence. It is not a
production-readiness, production-benefit, or production-SLO claim. G6 remains
the final release gate.
