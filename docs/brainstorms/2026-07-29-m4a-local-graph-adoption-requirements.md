---
date: 2026-07-29
topic: m4a-local-graph-adoption
milestone: M4A
gate: G4A
implementation_authorized: true
---

# M4A Local Graph Projection Adoption Decision

## Summary

M4A will determine whether one currently maintained local graph backend adds
material temporal or structural retrieval value over the accepted SQLite
adjacency baseline. Adoption is allowed only when the gain survives the same
governance, provenance, rebuild, fallback, privacy, resource, and operational
boundaries; a documented SQLite-only `NO-GO` is an equally complete outcome.

---

## Problem Frame

G3R established a bounded, scope-keyed L2/L3 Context capability on SQLite.
That baseline already supports deterministic relation traversal, correction,
purge propagation, lineage, replay, and degraded fallback. Adding a graph
database therefore has value only if it solves a demonstrated structural
retrieval problem that SQLite adjacency cannot solve adequately.

A graph dependency also adds another derived state plane, installation and
platform constraints, backup and restore work, corruption modes, disk and
memory cost, and a new path through which stale or unauthorized information
could reappear. Choosing a backend because graph-shaped data exists would
increase carrying cost without proving user value.

---

## Actors

- A1. Local user/operator: receives more useful bounded Context only when the
  graph lane is proven safe and beneficial, and retains a complete SQLite
  fallback.
- A2. Codex memory client: consumes graph-derived candidates through the same
  governed Context contract and can distinguish graph degradation from a
  proven no-match.
- A3. Memory Runtime: owns canonical filtering, projection lifecycle, result
  revalidation, receipts, and feature enablement.
- A4. Graph projection backend: stores only rebuildable L2/L3 nodes, edges,
  temporal properties, and lineage pointers.
- A5. Gate evaluator: freezes candidate identity, workloads, thresholds,
  environment, evidence, and the final `GO` or `NO-GO` receipt.

---

## Key Flows

- F1. Maintained-candidate qualification
  - **Trigger:** G3R is `GO` and M4A begins.
  - **Actors:** A3, A5
  - **Steps:** recheck current maintained candidates; compare locality,
    license, platform support, temporal and multi-hop capability, transaction
    and recovery behavior, deterministic export, deletion, resource cost, and
    operational burden; reject candidates that cannot satisfy hard
    invariants; freeze at most one qualified spike candidate.
  - **Escape path:** if no candidate passes qualification, record a supported
    `NO-GO` without forcing an adapter dependency.
  - **Outcome:** the spike has one reproducible candidate identity or a
    complete qualification-based rejection.
  - **Covered by:** R8, R19, R20

- F2. Derived projection and rebuild
  - **Trigger:** a qualified candidate is selected for a spike.
  - **Actors:** A3, A4
  - **Steps:** project versioned L2/L3 structure from canonical SQLite state;
    re-read authority before applying changes; consume changes
    idempotently; propagate correction, revocation, tombstone, and purge;
    rebuild the whole graph from canonical state; compare the rebuilt
    identity with the incremental identity.
  - **Escape path:** unavailable, corrupt, stale, or incomplete graph state is
    excluded from Context and rebuilt or disabled.
  - **Outcome:** graph state is disposable and never becomes a source of
    canonical memory truth.
  - **Covered by:** R8, R12, R14, R19, R20

- F3. Governed graph recall
  - **Trigger:** an allowed request enables the experimental graph lane.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** prefilter exact principal and scope in SQLite; traverse only the
    declared structural boundary; return bounded candidates and work
    telemetry; revalidate every result against live canonical revisions,
    lineage, lifecycle, and tombstone state; compile eligible items under the
    existing Context budget.
  - **Escape path:** graph outage, stale epoch, incomplete work, invalid
    lineage, or failed revalidation produces a typed degraded result and uses
    SQLite adjacency/L1 fallback.
  - **Outcome:** graph traversal cannot weaken authority, privacy, or Context
    explanations.
  - **Covered by:** R8, R12, R14, R19

- F4. G4A adoption decision
  - **Trigger:** qualification, spike, paired replay, resource, recovery, and
    review evidence are complete.
  - **Actors:** A1, A3, A5
  - **Steps:** compare the graph arm with the exact accepted SQLite adjacency
    baseline on a predeclared structural subset; verify invariants and
    operations separately from utility; bind reports to the tested
    executable and dependency identities; record `GO` or `NO-GO`.
  - **Escape path:** no material gain, any critical regression, unverifiable
    resource claim, or unresolved high-severity review finding yields
    `NO-GO`.
  - **Outcome:** downstream work can name one immutable graph decision and
    fallback configuration.
  - **Covered by:** R19, R20

---

## Inherited Requirements

The Product Contract in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md` remains the
only requirements-number authority. M4A does not introduce another R-number
namespace.

**Authority and lineage**

- R8. Every graph node, edge, traversal result, and Context item must
  drill down to live canonical SQLite revisions and evidence. Graph
  structure, traversal frequency, or connectivity never upgrades authority.
**Governed recall and propagation**

Product Contract R9 remains unchanged and belongs to the independent M4B
vector decision; M4A does not create a graph-specific replacement definition
for R9.

- R12. Exact principal, scope, lifecycle, validity, sensitivity, conflict,
  usage-block, and tombstone rules apply before traversal and again before a
  graph result enters Context.
- R14. Correction, replacement, revocation, deletion, and purge must
  invalidate affected graph descendants without affecting unrelated scopes
  or allowing stale structure to revive.

**Replay and gate evidence**

- R19. Projection, traversal, exclusions, bounded work, fallback, rebuild,
  and decision records must be reproducible and hash-bound to their source
  epochs, transforms, candidate backend, executable, dependency lock, and
  evaluation corpus.
- R20. Adoption requires a frozen paired evaluation showing predeclared
  structural benefit with zero critical governance, privacy, budget,
  correction, purge, rebuild, recovery, or partition regression.

---

## M4A Acceptance Examples

- M4A-AC1 — Qualification before dependency: given the candidate landscape
  has changed, when M4A starts, then maintenance and compatibility are checked
  against current first-party evidence before any backend is selected.
- M4A-AC2 — Supported early `NO-GO`: given no maintained local candidate
  satisfies the hard scorecard, when qualification completes, then M4A
  records a reproducible `NO-GO` and keeps SQLite adjacency without adding a
  graph dependency.
- M4A-AC3 — Disposable projection: given incremental graph state exists, when
  it is deleted and rebuilt from SQLite, then the resulting logical
  projection identity is equal and no authoritative information is lost.
- M4A-AC4 — Canonical correction: given an L1 source is corrected, revoked,
  usage-blocked, tombstoned, or purged, when the graph still contains an old
  path, then post-traversal revalidation excludes it and the graph projection
  converges without resurrecting the old value.
- M4A-AC5 — Exact-scope isolation: given structurally similar nodes exist in
  two scopes, when only one exact scope is allowed, then no traversal,
  telemetry, receipt, or Context item exposes the other scope.
- M4A-AC6 — Honest bounds: given traversal reaches a depth, start-set, fanout,
  result, time, or scan bound, then the response records exact bounded-work
  evidence and cannot report an exhaustive clean no-match.
- M4A-AC7 — Outage fallback: given the graph backend is missing, corrupt,
  locked, rebuilding, or returns a stale epoch, when Context is requested,
  then the runtime emits typed degradation and preserves the accepted SQLite
  adjacency/L1 behavior.
- M4A-AC8 — Structural gain: given the frozen structural subset, when graph
  and SQLite arms run with identical authority filters, cases, budgets, and
  scoring rules, then `GO` requires the predeclared material gain rather than
  more returned items or a tuned top-k.
- M4A-AC9 — Complete decision: given every utility and invariant gate has
  finished, when G4A is recorded, then the receipt names `GO` or `NO-GO`,
  tested commits, dependency and backend identities, environment, corpus,
  reports, remaining limits, and the active fallback.

---

## Success Criteria

- The candidate scorecard uses current first-party maintenance and product
  evidence rather than inherited vendor reputation.
- The structural failure subset and material-gain threshold are frozen before
  the spike is tuned or evaluated.
- At most one qualified backend is implemented far enough to test the full
  authority, rebuild, recovery, fallback, and paired-replay boundary.
- Every graph-derived candidate has live canonical lineage, exact-scope
  authorization, bounded-work telemetry, and a deterministic exclusion
  reason when rejected.
- Incremental and full-rebuild graph identities match on the frozen workload.
- The accepted SQLite adjacency arm remains semantically unchanged when the
  graph is disabled or unavailable.
- The final G4A decision is supported whether it is `GO` or `NO-GO`; neither
  outcome is treated as partial delivery.

---

## Scope Boundaries

- No change to SQLite authority, canonical memory identity, governance,
  tombstones, approvals, or receipts.
- No graph-backed canonical write path and no graph-only copy of required
  memory content.
- No vector index, embedding model, hybrid vector work, or G4B decision.
- No Learning Lab, candidate publication, model training, or G5 decision.
- No M6 production operations claim, remote service, cloud synchronization,
  multi-user platform, or enterprise knowledge graph.
- No simultaneous implementation of multiple graph backends.
- No default graph enablement before a `GO` decision and later release
  configuration explicitly allow it.
- No vendor adoption based solely on query syntax, benchmark marketing, graph
  model fit, or integration convenience.

---

## Key Decisions

- Qualification precedes implementation: an unmaintained, incompatible, or
  operationally opaque candidate is rejected before a spike.
- Freeze the structural gap before choosing or tuning the backend so the
  evaluation cannot redefine success around one product's strengths.
- Implement at most one qualified read/projection adapter; the goal is a
  decision, not a general graph-database framework.
- Keep canonical prefilter and post-traversal revalidation in SQLite even if
  that limits theoretical graph-query flexibility.
- Treat an evidence-backed `NO-GO` as successful M4A completion.
- Keep graph recall opt-in through G4A; a `GO` makes adoption eligible but
  does not itself prove M6 production readiness.

---

## Dependencies / Assumptions

- G3R `GO` at tested implementation
  `6224f782c86712488d416d8101ef7c9fa477c0ae` is the accepted graph-free
  baseline.
- The M0 corpus, G3 overlay, H3 regression suite, canonical serialization,
  dependency lock, and gate evidence remain available for compatibility and
  regression comparison.
- Candidate maintenance, licenses, platform bindings, and feature support are
  time-sensitive and must be refreshed during research.
- Local Darwin arm64 evidence can support the immediate local decision, but
  any unsupported platform or packaging boundary must remain explicit.

---

## Outstanding Questions

### Deferred to Research and Planning

- [Affects R8/R20][Needs research] Which currently maintained local graph
  candidates have first-party evidence for Node support, temporal properties,
  bounded multi-hop queries, transactions, backup/export, deterministic
  deletion, and local distribution?
- [Affects R8/R20][Needs research] Which frozen cases demonstrate a structural
  gap beyond the accepted SQLite adjacency behavior, and what gain is
  material enough to justify the added dependency?
- [Affects R14/R19][Technical] What backend-neutral logical projection
  identity makes incremental and full rebuilds comparable without depending
  on internal record IDs?
- [Affects R12/R19][Technical] Which traversal bounds and degradation reasons
  are necessary to keep graph work operationally honest and compatible with
  the existing Context telemetry?
- [Affects R20][Technical] Which resource, install, recovery, and operational
  thresholds come from the M0 envelope, and which must be declared
  M4A-specific before measurement?

## Decision

Proceed with a qualification-first, single-candidate spike. If no candidate
passes the frozen hard scorecard, stop with a supported `NO-GO`; otherwise
evaluate exactly one adapter against the accepted SQLite baseline and let the
predeclared G4A gate decide adoption.
