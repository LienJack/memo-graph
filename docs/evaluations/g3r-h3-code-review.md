# G3R H3 Full-Diff Code Review

- Review date: 2026-07-29
- Tested implementation:
  `6224f782c86712488d416d8101ef7c9fa477c0ae`
- Provisional implementation:
  `58b35d48020a2bd8ea3089b858d9a65eb3b9ff4b`
- Evidence commit before decision:
  `c092b26`
- Review scope: H3 U1-U6 implementation, the U8 review fix, migrations,
  contracts, storage reads/writes, runtime compilation, replay compatibility,
  regression tests, and frozen G3R evidence
- Verdict: **Ready for G3R GO**

## Outcome

The review found one P1 correctness defect in the provisional H3 candidate:
a mutation in scope A made the aggregate runtime discard otherwise-ready
projection candidates from unrelated scope B. That violated the H3 failure
oracle that invalidation must exclude only affected descendants.

The defect was fixed before the final candidate was frozen. Scope-local
projection state now advances with the canonical mutation, exact source
validation uses the matching scope-state epochs, and aggregate compilation
retains candidates from ready scopes while marking the affected scope
degraded. A multi-scope correction regression and direct storage frontier
assertions cover the repair.

There are no unresolved P0 or P1 findings.

## Resolved finding

### P1 — Unrelated ready-scope projections were removed

- **Observed on:** `58b35d48020a2bd8ea3089b858d9a65eb3b9ff4b`
- **Affected paths:**
  `packages/memory-kernel/src/index.ts`,
  `packages/storage-sqlite/src/governed-memory-reader.ts`, and
  `packages/storage-sqlite/src/projection-effects.ts`
- **Failure:** after a correction in one requested scope, the aggregate
  frontier fallback removed projection candidates from every requested scope.
- **Risk:** valid unrelated context disappeared and the runtime overstated the
  blast radius of a canonical mutation.
- **Resolution:** commit
  `6224f782c86712488d416d8101ef7c9fa477c0ae`.
- **Regression:** `h3_unrelated_scope_retention`.
- **Result:** fixed; affected scope A becomes pending/L1-only, while ready
  scope B retains its unchanged frontier and eligible projections.

## Review lenses

| Lens | Result | Evidence |
| --- | --- | --- |
| Correctness | Pass after P1 fix | late projection paging, exact lineage, two-scope permutation/retry/correction, V1 replay |
| Maintainability | Pass | boundaries remain split among storage, orchestrator, runtime, and compiler; no new optional subsystem |
| Testing | Pass | 9 named H3 regressions plus full 44-file suite |
| Project standards | Pass | work follows the Trellis unit order and keeps prior G3 artifacts immutable |
| Security/privacy | Pass | exact principal/scope filters remain before model-visible Context; default lane remains `recent_l1` |
| Reliability | Pass | scan/return/source/start/fanout bounds emit stable degraded reasons; L1 fallback remains available |
| API contracts | Pass | V2 scope frontier and bounded-work fields are additive; frozen V1 artifacts replay byte-for-byte |
| Data integrity | Pass | SQLite remains authoritative; scope states are additive migration `0011`; rebuild digest is equal |
| Performance | Pass | Small/Expected compiler p95 is below 1 ms in this local synthetic run; physical Small counts are exact |
| Simplicity | Pass | no FTS rewrite, graph backend, vector backend, or learning runtime was added to close H3 |

## Verification

| Check | Result |
| --- | --- |
| `pnpm test` | Pass: 44 files, 237 passed, 1 skipped |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm test:g3` | Pass, including accepted-M2 isolated checkout |
| `pnpm test:g3r:h3` | Pass: 8 files, 70 passed, 1 environment-gated case |
| `pnpm benchmark:g3 -- small` | Pass |
| `pnpm benchmark:g3 -- expected` | Pass |
| `pnpm benchmark:g3:resources` | Pass: exact Small counts and equal rebuild digest |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm audit --prod` | Pass: no known vulnerabilities |
| `pnpm verify:g3r` | Pass for tested commit `6224f782...` |
| Trellis context validation | Pass: implement 6/6, check 6/6 |

## Residual limits

- Evidence is local and synthetic on one Darwin arm64 machine.
- Only the Small SQLite resource population was physically materialized.
- Expected-profile timing is a bounded compiler-envelope measurement, not a
  production-capacity claim.
- Projection lanes remain disabled by default. GO makes downstream decisions
  eligible for their own workflow; it does not enable graph, vector, learning,
  or production release.
- M6 monitoring, recovery exercises, and production operational proof remain
  outside H3.

## Verdict

**Ready for G3R GO.** The historical four blockers and the U8 review finding
are closed on one hash-bound implementation, all required gates pass, and no
unresolved P0/P1 finding remains.
