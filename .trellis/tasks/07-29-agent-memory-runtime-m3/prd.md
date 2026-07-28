# Agent Memory Runtime M3 layered projections and Context Compiler

## Goal

Implement rebuildable L2/L3 topic, scenario, relation, procedural, and core
projections plus a governed multi-lane Context Compiler, then close G3 with
paired utility and pollution evidence.

## Authority

1. Product Contract R4, R7-R15, R19-R20; F2/F3; AE1-AE5.
2. Parent M3/G3 roadmap and architecture.
3. M3 brainstorm
   `docs/brainstorms/2026-07-29-layered-context-compiler-requirements.md`.
4. G2 decision `docs/evaluations/g2-decision.md`.

This child does not add or renumber product requirements.

## Requirements

- SQLite and governed L0/L1 remain the sole authority. Topic,
  scenario/procedural, relation, and core artifacts are derived projections.
- Every L2/L3 revision retains exact lineage, transform identity, scope,
  authority, sensitivity, validity, and projection frontier.
- Topic and Scenario remain distinct abstractions. SQLite adjacency is the
  graph-free reference relation behavior.
- Canonical source changes synchronously make affected descendants ineligible;
  projection rebuild may follow asynchronously.
- Recall hard-filters principal/scope/lifecycle/validity/sensitivity/lineage/
  tombstone/frontier before ranking.
- Recent/L1, topic, scenario/procedural, core, and relation lanes are
  independently observable, disableable, and degradable.
- Ranking and packing account for relevance, authority, freshness, evidence
  diversity, conflict cost, token utility, lane minimums, and a hard global
  budget.
- Conflicts remain provenance-bearing sets; repeated abstraction is discarded
  before governing constraints and failure boundaries.
- Context and retrieval receipts freeze compiler/lane/frontier state, ordered
  inclusions, exclusions, token estimates, and canonical hashes.
- G3 uses identical frozen cases and budgets to compare the layered compiler
  against the accepted baseline. Any governance regression is a hard hold.

## Out of scope

- Graph database/adoption, vector retrieval, learning release, automatic L1
  candidate extraction, remote transport, multi-user identity, and M6
  operational hardening.
- Treating a summary, relation, ranking score, or model output as canonical
  truth.
- Mutating historical L0/L1 evidence or already issued Context slices.

## Acceptance Criteria

- [ ] Topic, scenario/procedural, core, and temporal/relation projections are
      typed, versioned, evidence-bound, and deterministically rebuildable.
- [ ] Same source frontier and transform configuration produce identical
      projection identities, content hashes, relations, and eligible state.
- [ ] Correction, demotion, usage block, revoke, evidence purge, and tombstone
      prevent affected descendants from entering the next Context before
      projection cleanup.
- [ ] Rebuild excludes stale, unauthorized, invalid, conflicted, revoked, and
      tombstoned sources without resurrecting payloads.
- [ ] Every enabled lane applies canonical hard filters and can fail or be
      disabled without failing the safe lower-layer baseline.
- [ ] Conflict fixtures preserve competing claims, source authority, current
      status, and explicit selection/exclusion reasoning.
- [ ] The token packer never exceeds budgets from 1 through 32,000 and retains
      governing constraints/failure boundaries before redundant summaries.
- [ ] Frozen slices and receipts validate canonical hashes and record the exact
      compiler, policy, projection frontier, lane configuration, order, scores,
      and included/excluded reasons.
- [ ] Existing slices remain immutable after a memory/projection frontier
      change; the next compile produces the new governed view.
- [ ] Calibration, holdout, and transfer replay compare baseline/layered arms
      on identical cases and token budgets.
- [ ] G3 reports correctness, task/evidence utility, context pollution,
      governance, recovery, latency/disk cost, hashes, included/excluded cases,
      debt, and explicit `GO` or `HOLD`.
- [ ] M0-M2 regressions, lint, typecheck, build, frozen install, and dependency
      audit remain green on Node 24.18.0.

## Notes

- G2 is GO to M3 only. Do not open graph/vector/learning implementation from
  this task.
- If layered quality does not improve, M3 may finish with a documented
  `HOLD`/fallback while preserving the accepted L0/L1 compiler.
