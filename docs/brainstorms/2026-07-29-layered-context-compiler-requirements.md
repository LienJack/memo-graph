---
date: 2026-07-29
topic: layered-context-compiler
---

# M3 Layered Projections and Context Compiler

## Summary

M3 will derive traceable topic, scenario/procedural, relation, and core
projections from governed L0/L1 memory, then compile a bounded, explainable
Context through independently degradable recall lanes. G3 will admit the
layered compiler only when paired replay shows useful gain without weakening
governance or increasing context pollution.

---

## Problem Frame

The M2 runtime can preserve and safely recall individual L0 evidence and
versioned L1 memory. It does not yet organize repeated evidence into topics,
recognize reusable scenarios or procedures, expose relation structure, or
distill a small set of durable governing constraints. As histories grow, a
flat ranked list spends tokens on repeated details and makes cross-session
transfer depend on exact lexical overlap.

The main risk is not merely low recall. A summary or relation can amplify stale,
conflicting, out-of-scope, or deleted content after the canonical source has
changed. A layered compiler therefore has to improve usefulness while
remaining a derived, reversible view of the governed ledger.

---

## Assumptions

*This requirements doc was authored under the user's continuous-execution
instruction without synchronous M3 scope confirmation. These inferences must
be tested during research and planning rather than treated as established
product facts.*

- G3 should optimize evidence utility per token and designated task success,
  not the number of recalled records.
- The frozen G3 corpus can use deterministic, fixture-driven projection
  transforms; model-generated projection quality is not required to prove the
  authority, invalidation, rebuild, and packing contracts.
- SQLite adjacency is a complete relation-retrieval baseline. M4A may replace
  a derived lane only after measuring structural gain.
- Projection work may lag canonical mutations, but no stale derived candidate
  may enter a newly compiled Context.

---

## Actors

- A1. Local user/operator: owns memory scope, correction, deletion, sensitivity,
  and the final decision to accept or disable a projection lane.
- A2. Codex memory client: requests bounded task Context and consumes only the
  frozen slice and explanations returned by the governed compiler.
- A3. Projection and compiler runtime: derives rebuildable views, revalidates
  candidates against SQLite authority, and records included, excluded, and
  degraded outcomes.

---

## Key Flows

- F1. Derived projection lifecycle
  - **Trigger:** New or changed governed L0/L1 source state advances the memory
    frontier.
  - **Actors:** A1, A3
  - **Steps:** A3 identifies affected descendants, writes or invalidates
    versioned projections with exact lineage, advances a projection frontier,
    and can rebuild the same state from canonical sources.
  - **Outcome:** Every live L2/L3 item resolves to current governed sources;
    stale descendants remain in history but are ineligible.
  - **Covered by:** R4, R7, R8, R14, R15

- F2. Layered Context compilation
  - **Trigger:** A2 sends a task-scoped recall request with a hard token budget.
  - **Actors:** A2, A3
  - **Steps:** A3 applies hard filters, queries enabled lanes, revalidates
    candidates, presents conflicts, removes redundant abstractions, ranks by
    utility and diversity, packs within budget, and seals the result.
  - **Outcome:** A2 receives an immutable Context slice plus an explanation of
    every designated inclusion, exclusion, and degraded lane.
  - **Covered by:** R10, R11, R12, R13, R19

- F3. Failure, disablement, and rebuild
  - **Trigger:** A projection is stale/corrupt, a lane fails, or G3 detects no
    quality gain.
  - **Actors:** A1, A2, A3
  - **Steps:** A3 names the failed lane, excludes unverifiable candidates,
    serves the last safe lower-layer baseline, and rebuilds from SQLite without
    changing canonical memory.
  - **Outcome:** Recall remains safe and explicit; optional abstraction never
    becomes a startup, correction, or deletion dependency.
  - **Covered by:** R8, R12, R13, R14, R19, R20

---

## Requirements

The Product Contract in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md` remains the
only requirement-number authority. M3 refines, but does not renumber, these
requirements.

**Layered derived memory**

- R4. M3 must add distinct topic, scenario/procedural, relation, and core
  projections above L1 without changing L0/L1 authority.
- R7. Every projection must retain exact source lineage, transform identity,
  authority, sensitivity, validity, scope, and a monotonic projection frontier;
  no derived claim may become more authoritative than its sources.
- R8. Relation projections may express temporal, causal, dependency, topic,
  scenario, and entity structure, but must remain versioned, traceable,
  invalidatable, and rebuildable from SQLite.
- R14. Correction, demotion, usage policy, revoke, evidence deletion, and
  tombstone changes must make every affected descendant ineligible before it
  can enter a new Context and must enqueue deterministic rebuild work.
- R15. Historical projection revisions may remain for audit, but deleted or
  unauthorized source text must not survive through a summary, relation,
  receipt, or cached Context payload.

**Governed recall and packing**

- R10. Compilation must apply principal, exact scope, lifecycle, validity,
  sensitivity, lineage, tombstone, and projection-frontier filters before
  relevance ranking or budget allocation.
- R11. Recent/L1, topic, scenario/procedural, core, and SQLite-relation lanes
  must be independently observable and disableable. Every returned item must
  explain its abstraction, source lineage, lane, selection reason, and
  uncertainty.
- R12. The compiler must rank using relevance, authority, freshness, evidence
  diversity, conflict cost, and token utility; preserve governing constraints
  and failure boundaries before redundant summaries; and present conflict sets
  with provenance rather than silently merging them.
- R13. A failed or stale lane must produce a named degraded outcome. A request
  with no eligible result, a policy exclusion, and a runtime failure must stay
  observably distinct.

**Frozen evidence and gate**

- R19. Each compilation must persist the exact request frontier, enabled lane
  configuration, ordered included items, excluded identities/reasons, token
  estimates, compiler version, and hash. An issued slice is immutable; a later
  memory change affects only a new compilation.
- R20. G3 must compare the layered compiler against the frozen M1/M2 baseline
  on identical calibration, holdout, and transfer cases across correctness,
  task utility, context pollution, governance, recovery, latency, and disk
  cost. A lane with no measurable value or any safety regression stays off.

---

## Acceptance Examples

- AE1. **Covers R4, R7, R10, R11.** Given several sessions repeat one stable
  preference, when a related task compiles Context, then one traceable topic or
  core projection may replace redundant evidence while preserving drill-down
  to the current L1/L0 sources.
- AE2. **Covers R7, R12, R14.** Given two project-state claims conflict, when
  Context is compiled, then the conflict is shown with current status and
  provenance; correcting one source invalidates the old derived view before
  the next slice is issued.
- AE3. **Covers R10, R12, R20.** Given many lexically similar records from an
  unrelated scenario, when a small-budget request targets another scenario,
  then scope and scenario constraints reject the noise before ranking and the
  pollution fixture does not regress against baseline.
- AE4. **Covers R8, R14, R15.** Given a topic and relation both descend from a
  memory that is later deleted, when projection cleanup is delayed, then
  canonical revalidation prevents both descendants from entering Context and
  deterministic rebuild contains neither deleted payload.
- AE5. **Covers R13, R19.** Given the scenario lane fails while L1 and topic
  lanes remain healthy, when Context is compiled, then the result names the
  scenario degradation, seals only verified items, and does not describe the
  omitted scenario as absent memory.

---

## Success Criteria

- On the frozen G3 cases, the layered arm beats or matches the accepted
  baseline on designated task usefulness and evidence utility within the same
  token budget.
- Cross-scope leakage, tombstone resurrection, stale-descendant inclusion, and
  token-budget overflow remain zero.
- Every designated inclusion, exclusion, conflict, and degraded lane is
  explainable from a hash-valid receipt and exact source lineage.
- Rebuilding from the same L0/L1 frontier yields the same eligible projections,
  relations, and Context ordering.
- Any projection or lane can be disabled without losing the accepted L0/L1
  behavior.
- Planning can map every implementation unit and G3 assertion back to the
  inherited Product Contract without inventing user behavior.

---

## Scope Boundaries

- No graph database or graph adapter; M4A owns that independent decision.
- No embedding model, vector index, or semantic-gap claim; M4B owns that
  independent decision.
- No learning trace, candidate evaluation, canary, release, or rollback; M5
  owns learning.
- No automatic episode-to-L1 candidate extraction.
- No remote transport, multi-user identity, cloud synchronization, or
  production operations hardening.
- No model-generated projection may bypass deterministic lineage, governance,
  rebuild, and G3 evaluation.
- No mutation of historical L0/L1 evidence or issued Context slices.

---

## Key Decisions

- Separate topic from scenario/procedure: topical similarity and reusable
  operating conditions solve different recall problems.
- Keep all higher layers derived: the projection frontier may lag, but SQLite
  lifecycle and lineage remain the final eligibility oracle.
- Build multi-lane recall as a portfolio: a lane can add value, fail, or be
  rejected independently.
- Prefer constraint-preserving compression: repeated abstractions are dropped
  before preconditions, boundaries, conflicts, or failure/recovery facts.
- Treat SQLite relations as the reference implementation: G3 must be complete
  without graph or vector infrastructure.

---

## Dependencies / Assumptions

- G2 is GO on tested implementation commit
  `31959fc841ddc95f7570e5e0f2028a1e6b00243e`; the G2 evidence-only decision is
  `docs/evaluations/g2-decision.md`.
- Node 24.18.0, the frozen pnpm lock, schema frontier 0007, and the accepted
  M1/M2 compiler behavior are the compatibility baseline.
- The research phase must define projection semantics, source-frontier rules,
  deterministic rebuild inputs, lane utility metrics, and G3 paired fixtures
  before planning implementation.

---

## Outstanding Questions

### Deferred to Research and Planning

- [Affects R4, R7, R8][Needs research] What minimum typed projection artifacts
  preserve topic, scenario/procedural, core, and temporal relation semantics
  without creating a second authority?
- [Affects R12, R20][Needs research] Which frozen paired metrics can distinguish
  real task/evidence-utility gain from merely shorter or more abstract Context?
- [Affects R14, R19][Technical] Which frontier and invalidation contract makes
  asynchronous descendants safe under correction, revoke, purge, and rebuild?
- [Affects R10-R13][Technical] What deterministic lane quotas, tie-breaking,
  conflict presentation, and degradation behavior satisfy hard budgets without
  overfitting the current fixture set?
