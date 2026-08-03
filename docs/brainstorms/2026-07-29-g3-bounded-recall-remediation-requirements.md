---
date: 2026-07-29
topic: g3-bounded-recall-remediation
milestone: H3
gate: G3R
implementation_authorized: false
---

# G3 Bounded Recall and Frontier Remediation

## Summary

H3 will correct the four defects that forced G3 to `HOLD`: projection
relevance being applied after a storage limit, source-frontier validation
being capped at 1,000 rows, one projection frontier being reused across exact
scopes, and silent relation start-set truncation. It will then freeze a new
executable candidate and rerun the complete G3 decision without changing the
accepted M2 fallback or opening graph, vector, or learning work early.

## Problem frame

The M3 implementation passes its frozen one-scope replay, but that corpus does
not prove normal online recall behavior. A relevant projection can exist
outside the first storage prefix, a valid projection can reference sources
beyond the 1,000-row revalidation cap, and two requested scopes can own
different projection frontiers. In each case the current runtime can exclude
valid derived memory while presenting an incomplete explanation.

These are recall correctness and observability defects. No authorization
bypass or stale-value resurrection was found, and projection lanes remain
disabled by default. The accepted L0/L1 compiler therefore stays available
while H3 replaces the faulty derived-plane boundary.

## Actors and outcome

- A1. Local user/operator receives bounded Context without unexplained
  false-negative projection results.
- A2. Codex memory client can distinguish a proven no-match from a bounded or
  degraded search.
- A3. Storage, recall, and compiler runtime revalidate exact projection
  lineage and preserve one canonical frontier per exact scope.

The desired outcome is a new hash-bound G3 decision whose evidence directly
exercises all four review failures. H3 succeeds only when those regressions
pass alongside the original M0-M3 governance and utility suites.

## Inherited requirements

The Product Contract in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md` remains the
only requirements-number authority.

- R10. Candidate bounds must limit returned relevant candidates, not silently
  redefine which projection records are searchable. An incomplete bounded
  search is degraded or truncated, never a false `NO_MATCH`.
- R11. Receipts and lane telemetry must explain projection-search and relation
  truncation, exact-source exclusion, scope-local frontier selection, and safe
  fallback.
- R13. Proven no-match, policy exclusion, bounded degradation, and runtime
  failure remain distinct outcomes.
- R14/R15. Exact source revision revalidation must preserve correction,
  usage-block, revoke, tombstone, and purge suppression without copying source
  payload into a new authority.
- R19. A frozen multi-scope Context records an ordered frontier for every exact
  scope and replays each projection against its own recorded scope frontier.
- R20. A new executable candidate must pass the original G3 suite plus the
  review regressions, full repository checks, resource evidence, frozen
  installation, and dependency audit before downstream gates can open.

## H3 acceptance examples

- H3-AC1 — Late relevant projection: given the only relevant projection occurs
  after an unfiltered first page, bounded recall returns it or emits explicit
  truncation/degradation; it cannot return a clean `NO_MATCH`.
- H3-AC2 — Exact lineage above 1,000: given more than 1,000 active L1 sources,
  a returned projection whose lineage crosses that prefix is revalidated by
  exact revision identity and remains eligible when all ancestors are valid.
- H3-AC3 — Multi-scope frontier: given two exact scopes with different source
  and projection frontiers, both can contribute eligible items, both
  frontiers are frozen in canonical order, and replay validates each item
  against its own scope.
- H3-AC4 — Observable relation cap: given more relation start revisions than
  the configured cap, telemetry reports `truncated` with a stable reason code
  and the receipt cannot imply exhaustive traversal.
- H3-AC5 — Governance propagation: correction or tombstone in one requested
  scope excludes only affected descendants and cannot be hidden by an
  aggregate frontier.
- H3-AC6 — Safe fallback: any incomplete source batch, unavailable projection
  search, or invalid scope frontier names the degraded lane and preserves
  `recent_l1`.
- H3-AC7 — Re-freeze: the fixed implementation becomes a new immutable
  candidate; all replay, performance, environment, dependency, source, and
  report hashes refer to that candidate rather than the earlier U7 commit.

## Approaches considered

### A. Storage-native bounded search plus exact-source batch — selected

Define a storage boundary that applies the search predicate before the return
limit, reports cursor/truncation state, batch-loads the exact source revisions
named by returned projections, and returns scope-keyed frontier data. This
matches the semantic boundary that storage can actually prove and keeps the
compiler independent from SQLite query mechanics.

### B. Cursor through the existing projection query

Keep the current broad query and page until enough relevant records are found
or the corpus is exhausted. This can be correct with strict scan ceilings and
explicit degradation, but spends unpredictable work on irrelevant rows and
makes the recall layer responsible for storage pagination.

### C. Restrict layered compilation to one scope and smaller populations

Reject multi-scope requests and document the 1,000-source/100-relation limits.
This would reduce the immediate implementation surface but does not satisfy
the inherited R10/R11/R19 contract and would optimize the product around the
existing defect. It is rejected.

## Scope boundaries

- No graph database, vector index, embedding model, or graph/vector gate.
- No Learning Lab, candidate policy release, or automatic memory extraction.
- No ranking-weight or token-packing retuning unless a regression proves the
  current deterministic behavior incompatible with the corrected candidates.
- No mutation of historical Context slices or canonical L0/L1 memory.
- No claim of production capacity from synthetic compiler-only measurements.
- No M4A, M4B, or M5 child task until the new G3 decision is explicit.

## Success criteria

- All four review findings have focused failing-before/passing-after tests.
- Search completeness and every configured cap are observable in typed
  telemetry and sealed receipts.
- Exact lineage validation has no arbitrary scope-enumeration prefix.
- Multi-scope Context identity is deterministic under scope-order permutation.
- Original G3 utility gain, zero governance/pollution/budget regression,
  deterministic rebuild, and accepted-M2 parity remain green.
- The complete evidence manifest points to the new tested executable commit.

## Research questions

- Which current storage indexes and canonical query patterns can support
  relevance-before-limit without adding a new authority or semantic index?
- What exact-source batch result is required to distinguish missing,
  ineligible, conflicted, purged, and frontier-mismatched ancestors?
- How should scope-local frontiers be canonically ordered, hashed, persisted,
  and replayed while retaining compatibility with old one-scope slices?
- Which explicit caps and degradation reason codes make bounded work
  operationally honest without turning expected workloads into unbounded
  scans?
- What minimum fixture populations and assertions prove the repaired behavior
  rather than merely increasing coverage around the same narrow corpus?

## Decision

Proceed with Approach A as the planning default. Research may refine its query
and compatibility mechanics, but it may not weaken the completeness,
exact-lineage, scope-local frontier, degradation, or re-freeze requirements.
