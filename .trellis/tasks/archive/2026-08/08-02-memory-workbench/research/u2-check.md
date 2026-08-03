# U2 Sealed Correction Check

Checked on 2026-08-02 with Node.js 24.18.0.

## Verified Invariants

- Correction preview performs no durable SQLite mutation.
- Preview binds the current revision, normalized replacement, reason, exact-scope descendant closure, session, operation identity, and expiry.
- Workbench impact enumeration is complete up to the hard supported limit of 1,000 descendants; over-limit preview fails closed before approval or write.
- Confirmation revalidates the same scope-local closure seal in the governed immediate transaction. Unrelated scope progress does not change the seal.
- Inline `user_feedback` evidence, candidate/successor creation, current-pointer advance, complete descendant suppression, mutation receipt, projection work, and approval consumption share one rollback boundary.
- One preview can replay the same idempotent receipt after a lost response without a second successor or approval consumption.
- Two previews against one revision produce one CAS winner; the loser returns a stale-preview state with zero durable effect.
- Existing MCP correction and governance replay behavior remains compatible when Workbench-only optional fields are absent.

## Passing Gates

- Contracts, storage, and memory-kernel builds.
- Root TypeScript check.
- Changed-file lint.
- `tests/contract/workbench.contract.test.ts`
- `tests/governance/workbench-correction-impact.integration.test.ts`
- `tests/integration/workbench-correction-service.integration.test.ts`
- `tests/governance/correction.integration.test.ts`
- `tests/governance/derived-invalidation.integration.test.ts`
- `tests/replay/governance-replay.test.ts`
- `tests/integration/workbench-service.test.ts`
- 7 files, 25 tests passed in the final main-thread run.
- Independent Trellis check: 6 focused files, 21 tests passed; no additional defect found.
- `git diff --check` passed.
