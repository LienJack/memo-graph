# Agent Memory Runtime M4A graph adoption decision

## Goal

Decide whether one currently maintained local graph projection produces a
material, reproducible structural-retrieval gain over the accepted G3R SQLite
adjacency baseline without weakening authority, lineage, correction, purge,
rebuild, fallback, privacy, bounded work, or local operability.

The outcome is complete whether G4A records `GO` or an evidence-backed
`NO-GO`. SQLite remains the canonical authority and accepted fallback in both
cases.

## Product Authority

The only product requirement numbering is R1-R20 in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md`. The scoped
M4A requirements are captured in
`docs/brainstorms/2026-07-29-m4a-local-graph-adoption-requirements.md`.

M4A implements R8, R9, R12, R14, R19, and R20 without creating new product
requirement identifiers.

## Confirmed Facts

- G3R is `GO` at tested implementation
  `6224f782c86712488d416d8101ef7c9fa477c0ae`.
- SQLite adjacency already provides the graph-free L2/L3 baseline.
- Graph state, if any, is a disposable projection that never owns identity,
  authority, lifecycle, evidence, tombstones, approvals, or receipts.
- Kùzu was excluded as the default at G0 because its upstream repository was
  archived; the complete candidate landscape must be refreshed now.
- A supported SQLite-only `NO-GO` is a valid and releasable M4A result.

## Requirements

- Qualify current candidates using first-party evidence for maintenance,
  license, local operation, Node/platform support, temporal and multi-hop
  features, transactions, recovery, deterministic export/deletion, resource
  cost, and operational burden.
- Freeze the structural failure subset and material-gain threshold before
  selecting or tuning a backend.
- If no candidate clears hard qualification, record `NO-GO` without adding a
  graph dependency.
- If a candidate qualifies, spike exactly one backend behind a stable
  projection/recall boundary.
- Store only versioned derived nodes, edges, hashes, epochs, and canonical
  lineage pointers that can be rebuilt from SQLite.
- Apply exact SQLite authority and scope filters before traversal and
  revalidate every result afterward.
- Propagate correction, replacement, revoke, usage block, tombstone, purge,
  backup, and restore without stale-value resurrection.
- Bound and explain graph starts, depth, fanout, scan/work, results, and
  timeout behavior.
- Prove full rebuild identity, outage/corruption fallback, and disabled-lane
  equivalence to the accepted SQLite baseline.
- Bind the final `GO` or `NO-GO` to the tested executable, backend and
  dependency identities, corpus, thresholds, reports, review, environment,
  limitations, and active fallback.

## Acceptance Criteria

- [ ] Current maintained candidates are compared from first-party evidence;
      no backend is inherited from historical reputation.
- [ ] The structural subset and gain threshold are immutable before spike
      evaluation.
- [ ] No graph result enters Context without live canonical revision,
      evidence, exact scope, lifecycle, and tombstone revalidation.
- [ ] Correction or deletion invalidates affected graph descendants without
      changing unrelated scope eligibility.
- [ ] Incremental and full-rebuild logical projection identities match.
- [ ] Missing, corrupt, locked, stale, or rebuilding graph state degrades
      explicitly and preserves SQLite adjacency/L1 behavior.
- [ ] Traversal bounds appear as exact counts and stable reason codes; an
      incomplete traversal cannot produce a clean exhaustive no-match.
- [ ] Graph and SQLite arms use identical governance filters, cases, budgets,
      and predeclared scoring.
- [ ] `GO` requires material structural gain plus zero critical governance,
      privacy, correction, purge, rebuild, recovery, or partition regression.
- [ ] `NO-GO` leaves no runtime graph dependency enabled and is reported as
      completed M4A delivery.
- [ ] Full repository tests, static checks, frozen install, dependency audit,
      artifact verification, and full-diff review pass before G4A decision.

## Out of Scope

- G4B vector retrieval and embeddings.
- G5 Learning Lab or learning publication.
- M6 production release or remote/multi-user operation.
- Multiple graph backend implementations.
- Graph authority, graph-only memory content, or weakening SQLite filters.
- Default graph enablement before a later release configuration explicitly
  adopts a G4A `GO`.

## Research Handoff Questions

- Which maintained candidate, if any, clears every hard qualification?
- Which frozen cases prove a real structural gap beyond SQLite adjacency?
- What backend-neutral logical digest and traversal bounds support exact
  comparison?
- What local resource and operational thresholds must be predeclared?

## Planning Gate

This is a complex task. Before `task.py start`, M4A must also have:

- a research-to-article Claim/Evidence handoff;
- `design.md`;
- a complete `implement.md`;
- curated Trellis implement/check context;
- a reviewed final planning summary.

## Notes

- User authorized roadmap implementation on 2026-07-28.
- Every completed brainstorm, research, plan, implementation, decision,
  archive, and journal unit is committed separately.
- M4A follows
  `ce-brainstorm → research-to-article → ce-plan → ce-work` under Trellis.
