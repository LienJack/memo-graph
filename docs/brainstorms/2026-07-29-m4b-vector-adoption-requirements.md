---
date: 2026-07-29
topic: m4b-vector-adoption
milestone: M4B
gate: G4B
implementation_authorized: true
---

# M4B Optional Vector Retrieval Adoption Decision

## Summary

M4B will determine whether an optional semantic-vector candidate lane closes a
predeclared retrieval gap that the accepted FTS5, recency, layered projection,
and SQLite-relation baseline cannot close adequately. Adoption is allowed only
when the gain survives identical governance, Context-budget, privacy,
invalidation, rebuild, fallback, latency, disk, and operational constraints; a
documented FTS5-only `NO-GO` is an equally complete outcome.

---

## Problem Frame

G3R established a governed, bounded Context Compiler without a vector
dependency. It already combines FTS5, recency, active task state, L1 memory,
Topic/Scenario projections, and SQLite relations while preserving authority,
scope, lineage, conflict, tombstone, and budget rules.

Vector similarity may recover paraphrases or conceptually related material
that lexical and structural signals miss, but it also creates a derived copy
of memory content, a model and embedding lifecycle, new invalidation and purge
paths, resource cost, and a possible data-egress boundary. More candidates or
higher similarity scores are not user value by themselves; the lane is useful
only if it improves the task-relevant evidence selected into a fixed Context
budget without increasing pollution or weakening control.

---

## Assumptions

*This requirements doc is part of the user-authorized continuous roadmap
workflow. The items below are technical bets to test during research and
planning, not adopted product behavior.*

- A local embedding path is the preferred qualification target because it
  avoids sending the full memory corpus to a separate remote embedding
  service; any remote path would require an explicit, separately reviewed
  egress contract.
- M4B should qualify and evaluate at most one model/index combination after
  the semantic-gap subset and thresholds are frozen.
- A vector `GO` makes the lane eligible for later release configuration; it
  does not make the lane mandatory or prove M6 production readiness.

---

## Actors

- A1. Local user/operator: receives better bounded Context only when semantic
  retrieval is proven useful and safe, can disable the lane, and retains a
  complete FTS5/layered fallback.
- A2. Codex memory client: consumes vector-derived candidates through the same
  governed Context contract and can distinguish no match, policy exclusion,
  and vector degradation.
- A3. Memory Runtime: owns canonical prefiltering, embedding eligibility,
  postvalidation, lane lifecycle, receipts, and feature enablement.
- A4. Optional embedding/index subsystem: stores only versioned, rebuildable
  derived vectors and canonical lineage pointers.
- A5. Gate evaluator: freezes semantic-gap cases, candidate identity,
  thresholds, environment, reports, and the final `GO` or `NO-GO` receipt.

---

## Key Flows

- F1. Semantic-gap declaration and candidate qualification
  - **Trigger:** G3R is `GO` and the independent M4B workflow begins.
  - **Actors:** A3, A5
  - **Steps:** identify frozen cases where the accepted baseline misses
    task-relevant evidence; declare material-gain and non-regression
    thresholds; assess current model/index candidates for maintenance,
    license, local execution, platform support, model provenance, dimensions,
    normalization, determinism, privacy, deletion, rebuild, and resource cost;
    freeze at most one qualified combination.
  - **Escape path:** if no semantic gap or no candidate clears hard
    qualification, record a supported `NO-GO` without adding a runtime vector
    dependency.
  - **Outcome:** evaluation has an immutable gap subset and one reproducible
    candidate identity, or a complete early rejection.
  - **Covered by:** R9, R19, R20

- F2. Embedding lifecycle and governed recall
  - **Trigger:** a qualified candidate is selected for a spike.
  - **Actors:** A2, A3, A4
  - **Steps:** select only canonically eligible revisions; derive vectors under
    one embedding epoch; generate bounded semantic candidates inside exact
    principal and scope; postvalidate live authority, lifecycle, validity,
    sensitivity, conflict, usage, lineage, and tombstone state; combine
    eligible candidates under the existing Context budget.
  - **Escape path:** unavailable, stale, incomplete, unauthorized, or failed
    vector work is excluded and the accepted FTS5/layered path remains active.
  - **Outcome:** similarity can expand candidate generation but cannot decide
    truth, authority, promotion, or final Context inclusion.
  - **Covered by:** R9, R10, R11, R12, R13

- F3. Correction, purge, and epoch rebuild
  - **Trigger:** a source is corrected, replaced, revoked, usage-blocked,
    tombstoned, purged, restored from backup, or re-embedded under a new model
    epoch.
  - **Actors:** A1, A3, A4
  - **Steps:** make the old revision immediately ineligible; propagate
    invalidation to derived vectors; rebuild from live canonical SQLite state;
    verify that canonical revision identities and unrelated scopes remain
    unchanged; record residual debt until physical purge is proven.
  - **Escape path:** uncertain or partial propagation keeps affected vectors
    quarantined and falls back to non-vector recall.
  - **Outcome:** stale or deleted content cannot re-enter Context through
    similarity, an old index, or a restored snapshot.
  - **Covered by:** R14, R19, R20

- F4. G4B adoption decision
  - **Trigger:** qualification, paired replay, privacy, resource, recovery, and
    review evidence are complete.
  - **Actors:** A1, A3, A5
  - **Steps:** compare `fts_recency`, accepted `layered`, `vector`, and
    `hybrid` arms on identical frozen cases, readers, governance filters, and
    Context budgets; score task-relevant evidence utility and Context
    pollution separately from latency, disk, memory, and rebuild cost; bind
    every result to the tested executable, dependency lock, model/index
    identity, embedding epoch, corpus, and environment; record `GO` or
    `NO-GO`.
  - **Escape path:** no material paired gain, any critical governance/privacy
    regression, unacceptable resource cost, or unresolved high-severity
    review finding yields `NO-GO`.
  - **Outcome:** downstream learning and release work can name one immutable
    vector decision and active fallback configuration.
  - **Covered by:** R9, R19, R20

---

## Inherited Requirements

The Product Contract in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md` remains the
only requirements-number authority. M4B does not introduce another R-number
namespace.

**Vector boundary**

- R9. Vector similarity is an optional candidate-generation signal. It is not
  a required dependency and cannot determine truth, scope, authority,
  applicability, or promotion.

**Governed recall**

- R10. Vector work must be bounded by the current task, exact principal,
  allowed scope, scene, time, and caller Context budget.
- R11. Any selected vector result must retain source, layer, current status,
  selection reason, embedding epoch, and uncertainty sufficient to explain why
  it appeared.
- R12. Vector and hybrid arms must apply the same duplicate, stale,
  superseded, conflict, sensitivity, usage-block, tombstone, authority,
  complementarity, and source-diversity controls as the accepted baseline.
- R13. No semantic hit, policy exclusion, vector outage, stale epoch, timeout,
  and incomplete bounded work must remain distinguishable.

**Correction and evidence**

- R14. Correction, replacement, revocation, usage block, deletion, and purge
  must immediately remove affected vectors from eligibility and converge the
  derived index without affecting unrelated scopes.
- R19. Embedding generation, exclusions, invalidation, rebuild, recall,
  fallback, evaluation, and decision records must be reproducible and
  hash-bound to canonical revisions, transforms, model/index identity,
  embedding epoch, executable, dependency lock, corpus, and environment.
- R20. Adoption requires a frozen paired replay showing predeclared semantic
  benefit with zero critical governance, privacy, correction, purge, rebuild,
  recovery, budget, or partition regression.

---

## M4B Acceptance Examples

- M4B-AC1 — Gap before model: given the accepted baseline has known replay
  failures, when M4B begins, then the semantic-gap cases and material-gain
  threshold are frozen before selecting or tuning an embedding model or
  index.
- M4B-AC2 — Supported early `NO-GO`: given the frozen subset does not show a
  meaningful semantic gap or no current candidate satisfies hard privacy and
  operational constraints, when qualification completes, then M4B records a
  reproducible `NO-GO` without enabling a vector dependency.
- M4B-AC3 — Similarity is not authority: given a high-similarity revision is
  out of scope, stale, conflicted, usage-blocked, sensitive, tombstoned, or
  lacks live lineage, when recall runs, then it cannot enter Context and the
  exclusion is explainable.
- M4B-AC4 — Exact-scope isolation: given semantically similar content exists
  in two scopes, when only one exact scope is allowed, then embedding,
  retrieval telemetry, receipts, and Context expose no content or membership
  signal from the other scope.
- M4B-AC5 — Mutation and purge: given an embedded source is corrected,
  revoked, blocked, tombstoned, or purged, when the old vector remains in a
  stale physical index, then canonical postvalidation excludes it immediately
  and rebuild proves the stale content and residual are removed.
- M4B-AC6 — Epoch migration: given the embedding model, dimensions, or
  normalization changes, when a new epoch is rebuilt, then canonical revision
  identities remain unchanged, old and new epochs cannot mix silently, and
  fallback remains available during transition.
- M4B-AC7 — Disabled and degraded equivalence: given the vector lane is
  disabled, missing, locked, corrupt, stale, timed out, or rebuilding, when
  Context is requested, then the accepted FTS5/layered result and governance
  behavior remain semantically equivalent with a typed degradation receipt.
- M4B-AC8 — Paired net value: given the frozen semantic-gap subset, when all
  four arms run with identical cases, hard filters, readers, and Context
  budgets, then `GO` requires predeclared task-relevant evidence gain without
  unacceptable pollution, privacy, latency, disk, memory, or rebuild cost.
- M4B-AC9 — Complete decision: given utility and invariant gates are complete,
  when G4B is recorded, then the receipt names `GO` or `NO-GO`, tested commits,
  dependency and candidate identities, model provenance, local/remote
  boundary, embedding epoch, corpus, reports, limitations, and active
  fallback.

---

## Success Criteria

- The semantic-gap subset and thresholds are immutable before candidate
  selection or tuning.
- Current first-party evidence establishes model/index maintenance, license,
  provenance, platform, execution, privacy, and lifecycle constraints.
- At most one qualified vector combination is implemented far enough to test
  the complete governance, purge, epoch, rebuild, degradation, and paired
  replay boundary.
- Every vector-derived candidate maps to a live canonical revision and carries
  exact-scope authorization, embedding epoch, bounded-work telemetry, and a
  deterministic exclusion reason when rejected.
- Correction and purge prevent stale content from being selected immediately
  and remove all derived residuals on rebuild.
- The accepted FTS5/layered arm is unchanged when vectors are disabled or
  unavailable.
- The final G4B decision is supported whether it is `GO` or `NO-GO`; neither
  outcome is treated as partial delivery.

---

## Scope Boundaries

- No change to SQLite authority, canonical memory identity, governance,
  tombstones, approvals, or receipts.
- No vector-only memory content and no vector database as a required runtime
  dependency.
- No similarity-based truth, promotion, scope expansion, or policy bypass.
- No graph reevaluation or change to the completed G4A `NO-GO`.
- No Learning Lab, candidate publication, model training, or G5 decision.
- No M6 production-readiness claim, cloud memory service, multi-user platform,
  generic RAG, or vector-database management product.
- No simultaneous evaluation of multiple runtime adapters after
  qualification.
- No default vector enablement before a `GO` decision and later release
  configuration explicitly allow it.

---

## Key Decisions

- Freeze the user-value gap before the embedding mechanism so success cannot
  be redefined around one model's strengths.
- Treat embedding generation and indexing as derived computation over
  canonical eligibility, never as a new fact plane.
- Compare vector-only and hybrid behavior with the accepted baseline, but
  require net Context utility rather than more recall candidates.
- Keep exact SQLite governance before candidate generation where possible and
  always postvalidate before Context inclusion.
- Treat model, dimensions, normalization, execution boundary, and index
  representation as one versioned embedding epoch.
- Treat an evidence-backed `NO-GO` as successful M4B completion.
- Keep the vector lane optional after `GO`; adoption eligibility is separate
  from M6 release readiness.

---

## Dependencies / Assumptions

- G3R `GO` at tested implementation
  `6224f782c86712488d416d8101ef7c9fa477c0ae` is the accepted vector-free
  baseline.
- G4A `NO-GO` at tested implementation
  `36421f5cd75007a1421d3e0594e7881dd4b864b2` leaves SQLite relations as the
  accepted structural configuration and does not block M4B.
- The M0 corpus, G3/G3R fixtures, Context Compiler, canonical serialization,
  dependency lock, and gate evidence remain available for paired comparison.
- Candidate maintenance, licenses, model files, platform bindings, and
  execution support are time-sensitive and must be refreshed during research.
- Darwin arm64 can support the immediate local decision, but unsupported
  platform and packaging boundaries must remain explicit.

---

## Outstanding Questions

### Deferred to Research and Planning

- [Affects R9/R20][Needs research] Which current local embedding runtimes,
  models, and local vector index choices have first-party evidence for Node 24
  support, maintained distribution, license compatibility, model provenance,
  deterministic dimensions/normalization, deletion, and rebuild?
- [Affects R9/R20][Needs research] Which frozen cases prove a real semantic
  gap beyond FTS5, recency, layered projections, and SQLite relations, and
  what gain is material enough to justify the added lifecycle?
- [Affects R10/R12][Technical] Which canonical eligibility boundary minimizes
  side-channel exposure while still allowing useful semantic candidate
  generation?
- [Affects R14/R19][Technical] What epoch and logical-index digest make
  incremental updates, full rebuilds, backup/restore, and physical purge
  comparable without depending on unstable internal index IDs?
- [Affects R20][Technical] Which latency, memory, disk, model-size, rebuild,
  install, and privacy thresholds are inherited from M0 and which must be
  frozen specifically for M4B?

## Decision

Proceed with a gap-first, single-candidate spike. If no candidate passes the
hard scorecard, stop with a supported `NO-GO`; otherwise evaluate exactly one
versioned embedding/index lane against the accepted vector-free baseline and
let the predeclared G4B gate decide adoption.
