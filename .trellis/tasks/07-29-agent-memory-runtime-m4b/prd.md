# Agent Memory Runtime M4B vector adoption decision

## Goal

Decide whether one optional, versioned semantic-vector candidate lane produces
a material, reproducible task-relevant evidence gain over the accepted
FTS5/recency/layered/SQLite-relation baseline without weakening authority,
scope, Context budget, explanation, privacy, correction, purge, rebuild,
fallback, or local operability.

The outcome is complete whether G4B records `GO` or an evidence-backed
`NO-GO`. The accepted vector-free path remains available in both cases.

## Product Authority

The only product requirement numbering is R1-R20 in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md`. The scoped
M4B requirements are captured in
`docs/brainstorms/2026-07-29-m4b-vector-adoption-requirements.md`.

M4B implements R9-R14, R19, and R20 without creating new product requirement
identifiers. It does not reopen the completed G4A graph decision.

## Confirmed Facts

- G3R is `GO` at tested implementation
  `6224f782c86712488d416d8101ef7c9fa477c0ae`.
- G4A is `NO-GO` at tested implementation
  `36421f5cd75007a1421d3e0594e7881dd4b864b2`; SQLite relations remain the
  accepted structural configuration.
- FTS5, recency, layered projections, SQLite relations, and the governed
  Context Compiler already form a vector-free baseline.
- Vector state, if any, is a disposable projection that never owns identity,
  authority, lifecycle, evidence, tombstones, approvals, or receipts.
- A supported vector-free `NO-GO` is a valid and releasable M4B result.

## Requirements

- Freeze a semantic-gap subset and material-gain threshold before selecting or
  tuning an embedding model or index.
- Qualify current candidates using first-party evidence for maintenance,
  license, model provenance, local execution, Node/platform support,
  dimensions, normalization, deterministic versioning, deletion, rebuild,
  resource cost, and operational burden.
- If no gap or candidate clears hard qualification, record `NO-GO` without
  adding an enabled runtime vector dependency.
- If a candidate qualifies, spike exactly one model/index combination behind
  an optional candidate-generation boundary.
- Embed and index only canonically eligible revisions and keep exact scope and
  principal partitioning from becoming a cross-scope membership side channel.
- Apply the same authority, scope, lifecycle, validity, sensitivity, conflict,
  usage, lineage, tombstone, complementarity, and Context-budget controls used
  by every other lane.
- Version model, dimensions, normalization, preprocessing, execution boundary,
  and index representation as an immutable embedding epoch.
- Propagate correction, replacement, revoke, usage block, tombstone, purge,
  backup, and restore without stale-value resurrection.
- Prove full rebuild identity, epoch transition isolation, outage/corruption
  fallback, and disabled-lane equivalence to the accepted vector-free baseline.
- Compare `fts_recency`, `layered`, `vector`, and `hybrid` on identical frozen
  cases, readers, governance filters, and Context budgets.
- Bind the final `GO` or `NO-GO` to the tested executable, model/index and
  dependency identities, embedding epoch, corpus, thresholds, reports,
  review, environment, limitations, privacy boundary, and active fallback.

## Acceptance Criteria

- [ ] The semantic-gap subset and gain threshold are immutable before model or
      index selection.
- [ ] Current candidates are compared from first-party evidence; no model,
      runtime, or index is inherited from reputation.
- [ ] No vector result enters Context without a live canonical revision,
      exact-scope authorization, lineage, lifecycle, sensitivity, usage, and
      tombstone revalidation.
- [ ] Cross-scope content and membership signals are excluded from embedding,
      lookup, telemetry, receipts, and Context.
- [ ] Correction, revoke, usage block, tombstone, and purge make old vectors
      immediately ineligible and converge the physical index without affecting
      unrelated scopes.
- [ ] A new embedding epoch rebuilds without changing canonical revision
      identity or silently mixing old and new representations.
- [ ] Missing, corrupt, locked, stale, timed-out, or rebuilding vector state
      degrades explicitly and preserves accepted FTS5/layered behavior.
- [ ] All four evaluation arms use identical governance filters, cases,
      readers, Context budgets, and predeclared scoring.
- [ ] `GO` requires material paired semantic gain plus zero critical
      governance, privacy, correction, purge, rebuild, recovery, budget, or
      partition regression.
- [ ] `NO-GO` leaves no runtime vector dependency enabled and is reported as
      completed M4B delivery.
- [ ] Full repository tests, static checks, frozen install, dependency audit,
      artifact verification, and full-diff review pass before G4B decision.

## Out of Scope

- Reopening G4A or adding a graph backend.
- G5 Learning Lab, learning publication, or model training.
- M6 production release or remote/multi-user operation.
- Multiple vector runtime/model/index implementations.
- Vector authority, vector-only memory content, or weakening SQLite filters.
- Generic document RAG or vector-database management capability.
- Default vector enablement before a later release configuration explicitly
  adopts a G4B `GO`.

## Research Handoff Questions

- Which current local candidate, if any, clears every hard qualification?
- Which frozen cases prove a real semantic gap beyond the accepted baseline?
- What epoch, logical digest, and partition boundary support exact lifecycle
  comparison?
- What privacy, resource, install, recovery, and operational thresholds must
  be predeclared?

## Planning Gate

This is a complex task. Before `task.py start`, M4B must also have:

- a research-to-article Claim/Evidence handoff;
- `design.md`;
- a complete `implement.md`;
- curated Trellis implement/check context;
- a reviewed final planning summary.

## Notes

- User authorized continuous roadmap implementation.
- Every completed brainstorm, research, plan, implementation, decision,
  archive, and journal unit is committed separately.
- M4B follows
  `ce-brainstorm → research-to-article → ce-plan → ce-work` under Trellis.
