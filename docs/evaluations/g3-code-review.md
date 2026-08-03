# G3 Post-Implementation Code Review

- Mode: `autofix`
- Review scope: M3 commits after `a1e6abc`
- Reviewed HEAD: `5e4c75404e288402c0c1253807cd9eed2a8414ef`
- Plan:
  `docs/plans/2026-07-29-001-feat-layered-context-compiler-plan.md`
- Verdict: **Not ready for G3 GO**
- Resolution: change G3 to **HOLD**; keep the accepted M2 fallback

## Intent

Review the completed M3 contracts, migrations, projection lifecycle, recall
lanes, compiler, runtime/MCP integration, frozen replay, and evidence against
R4, R7-R15, R19-R20 and the Trellis execution checklist.

## Review lenses

Always-on review covered correctness, testing, maintainability, project
standards, agent-native access, and prior project learnings. Conditional
review covered security, performance, API contracts, migrations, reliability,
adversarial failure modes, and TypeScript implementation quality.

## Findings

### P1 — High

| # | File | Issue | Confidence | Route |
| --- | --- | --- | ---: | --- |
| 1 | `packages/memory-kernel/src/lane-retrievers.ts:153` | Projection rows are limited before lexical relevance filtering, so relevant rows outside the initial prefix become false `NO_MATCH` results | 100 | `manual -> downstream-resolver` |
| 2 | `packages/memory-kernel/src/recall-orchestrator.ts:264` | Canonical frontier revalidation reads at most 1,000 sources while consolidation may hash up to 100,000, rejecting valid projections above the cap | 100 | `manual -> downstream-resolver` |
| 3 | `packages/memory-kernel/src/index.ts:592` | Multi-scope compilation chooses one projection frontier and applies it to candidates from every scope | 100 | `manual -> downstream-resolver` |

### P2 — Moderate

| # | File | Issue | Confidence | Route |
| --- | --- | --- | ---: | --- |
| 4 | `packages/memory-kernel/src/lane-retrievers.ts:193` | Relation traversal silently drops start revisions after the first 100 without setting `truncated` or a stable reason code | 100 | `manual -> downstream-resolver` |

The P2 fix changes the lane telemetry contract and any executable change would
invalidate the frozen U7 candidate. It is therefore grouped into the required
G3 remediation and re-freeze.

## Requirements completeness

- R4/R7/R8/R14/R15: implemented and covered for deterministic local
  projection lifecycle, purge, and rebuild.
- R10/R11: **partial** because bounded retrieval can discard relevant
  projections before matching and source revalidation truncates the
  authoritative set.
- R12/R13: implemented for the pure compiler and frozen cases; runtime scale
  coverage remains blocked by retrieval.
- R19: **partial** because one frontier cannot faithfully represent
  scope-local projection states in a multi-scope request.
- R20: the declared corpus and compiler benchmarks pass, but they do not cover
  these normal-usage failures; the final decision must therefore be HOLD.
- U1-U7: corresponding work appears in the diff.
- U8: evidence exists and is hash-bound, but the originally recorded GO was
  corrected to HOLD. The planned repository README was also missing and was
  added during review.

## Testing gaps

- No layered runtime test compiles more than one exact scope.
- No recall test places the only relevant projection after the storage query
  prefix.
- No online recall test uses more than 1,000 active L1 sources.
- No telemetry test asserts relation start-set truncation.

## Security and agent-native review

No cross-scope content leak or authorization bypass was found. Projection
candidates still pass exact principal/scope and canonical source checks before
the compiler, and projection lanes remain disabled by default. Layered Context
is available through the same typed runtime and MCP surface, so no
agent-access parity gap was found.

## Migration and recovery review

Migrations `0008`-`0010` are forward-only, tested through schema `0010`, and
have matching purge/restore coverage. No unrelated schema drift was found.
The HOLD is caused by online retrieval/frontier composition, not migration
integrity or deletion safety.

## Coverage

- Suppressed findings below confidence 75: 0
- Mode-aware demotions: 0
- Pre-existing findings: 0
- Failed reviewers: 0; review lenses were executed sequentially in the main
  thread under the repository's agent-routing rule
- Residual actionable work: the four remediation items are frozen into
  `docs/evaluations/g3-decision.md`; they block downstream gates

## Verdict

**Not ready for G3 GO.** The safe outcome is G3 HOLD with the M2 L0/L1
compiler retained as the release boundary. A new executable candidate must
close the findings and rerun the complete hash-bound gate before M4A, M4B, or
M5 starts.
