---
date: 2026-07-29
status: ready-for-implementation
milestone: H3
gate: G3R
branch: codex/agent-memory-runtime-h3
---

# G3 Bounded Recall Remediation — Unified Plan

## Outcome

Repair the four correctness defects that placed G3 on `HOLD`, freeze a new
executable candidate, and make a fresh G3R `GO`/`HOLD` decision. The accepted
M2 L0/L1 compiler remains the release boundary until that decision is `GO`.

This plan implements Product Contract R10, R11, R13–R15, R19–R20. It does not
create new product requirement identifiers.

## Inputs

- Requirements:
  `docs/brainstorms/2026-07-29-g3-bounded-recall-remediation-requirements.md`
- PRD:
  `.trellis/tasks/07-29-agent-memory-runtime-h3/prd.md`
- Fixed-commit research:
  `.trellis/tasks/07-29-agent-memory-runtime-h3/research/research-handoff.md`
- Technical design:
  `.trellis/tasks/07-29-agent-memory-runtime-h3/design.md`
- Executable checklist:
  `.trellis/tasks/07-29-agent-memory-runtime-h3/implement.md`
- Historical G3 decision:
  `docs/evaluations/g3-decision.md`

## Why G3 is not currently adoptable

The frozen M3 replay passed, but its single-scope corpus did not exercise four
online boundaries:

1. SQLite returns a limited projection prefix before relevance is tested.
2. Recall revalidates only 1,000 scope sources although consolidation can use
   100,000.
3. Storage has one projection-state singleton and runtime compiles one scalar
   frontier for all requested scopes.
4. Relation starts are sliced to 100 before repository telemetry exists.

These defects create unexplained false negatives and incorrect frontier
binding. They do not authorize changing the canonical L0/L1 ledger or enabling
derived lanes by default.

## Chosen repair

### Bounded search

Use stable projection cursor pages and preserve the current normalized
JavaScript matcher. The return limit applies to relevant matches. A separate
operator scan ceiling limits work; hitting it is a typed degradation. This is
smaller and semantically safer than introducing FTS during a correctness
repair.

### Exact lineage

Batch only the source revision IDs named by retrieved projections. Validate
them inside one SQLite read snapshot and return one typed result per ID. Scope
freshness comes from persisted scope state, never from enumerating a prefix.

### Scope frontiers

Add migration `0011` with a principal-plus-exact-scope frontier table. Keep the
old singleton as global health/CAS state. New Contexts use canonical V2 scoped
frontiers; old scalar V1 artifacts retain their original bytes and replay
meaning.

### Honest bounds

Seal structured counts and stable reason codes for projection scan/return,
source batch, relation starts, and relation fanout. Incomplete work cannot
produce clean `NO_MATCH`.

## Ordered delivery

| Unit | Delivery | Primary proof | Commit |
|---|---|---|---|
| U1 | V2 frontier, cursor, exact batch, policy, telemetry contracts | contract invalid/boundary/compatibility tests | `feat(contracts): define bounded recall contracts` |
| U2 | migration `0011`, scope-state writes/readiness, consolidation use | two-scope storage and rebuild tests | `feat(storage): persist scope projection frontiers` |
| U3 | stable projection paging and late-match repair | late-row and scan-ceiling tests | `feat(storage): add bounded projection reads` |
| U4 | exact source snapshot batch and governance propagation | >1,000 and revoke/purge tests | `feat(memory): revalidate exact projection lineage` |
| U5 | V2 multi-scope compiler/runtime/replay | permutation, epoch drift, V1 replay | `feat(context): compile scope-keyed frontiers` |
| U6 | relation start/fanout telemetry and receipt | >100-start receipt test | `feat(memory): expose relation truncation` |
| U7 | new frozen candidate and three-arm evidence | focused H3 plus original G3/M2 | `test(g3): freeze bounded recall remediation` |
| U8 | full review and explicit G3R decision | all gates and hashes | `docs(g3): record bounded recall decision` |

No unit begins before its dependencies pass. Every completed unit is committed
before the next begins.

## Acceptance trace

| H3 acceptance | Units | Oracle |
|---|---|---|
| H3-AC1 late relevant projection | U1, U3, U7 | returned after paging or named scan degradation; never false `NO_MATCH` |
| H3-AC2 exact lineage above 1,000 | U1, U4, U7 | exact requested ancestor validates independent of scope population |
| H3-AC3 multi-scope frontier | U1, U2, U5, U7 | both scopes eligible and permutation-stable |
| H3-AC4 relation cap | U1, U6, U7 | exact counts/reasons in telemetry and receipt |
| H3-AC5 governance propagation | U2, U4, U5, U7 | only affected descendants excluded |
| H3-AC6 safe fallback | U3–U6 | projection failure is typed; `recent_l1` continues |
| H3-AC7 re-freeze | U7, U8 | new executable/report/hash manifest and explicit decision |

## Compatibility and rollback

- Migration `0011` is additive.
- Existing projection revisions remain stored.
- Missing verified scope state means pending/degraded projection recall until
  consolidation or rebuild; it never means stale projection acceptance.
- Old Context and receipt JSON is never rewritten.
- Projection lanes remain disabled by default.
- Any failed unit can fall back to M2 without a canonical-data rollback.
- A failed final gate produces G3R `HOLD`, not a partial release.

## Verification ladder

Each unit runs its focused tests and static checks. U7/U8 additionally run:

```bash
pnpm test:g3
pnpm benchmark:g3
pnpm benchmark:g3:resources
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm install --frozen-lockfile
pnpm audit --prod
python3 .trellis/scripts/task.py validate 07-29-agent-memory-runtime-h3
```

The final review checks correctness, maintainability, testing, project
standards, security, reliability, API contracts, data integrity, performance,
and simplicity. An unresolved P0/P1 finding forces `HOLD`.

## Stop boundary

H3 ends after its explicit G3R decision and Trellis archive commit. Graph,
vector, learning, or M6 work is not started in this task. No push or PR is
authorized by this plan.
