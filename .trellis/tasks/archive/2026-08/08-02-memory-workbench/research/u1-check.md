# U1 Governed Workbench Read Check

Checked on 2026-08-02 with Node.js 24.18.0.

## Scope

- Browser-safe Workbench contracts and explicit state distinctions.
- SQLite governed list, immutable-member reload, detail, history, and bounded provenance reads.
- Worker protocol, recovery-operation mapping, client, and package exports.
- Kernel-owned principal/scope authority and host-facing snapshot registry interface.
- Stable snapshot behavior after correction, typed stale cursors, exact-scope grouping, truncation truthfulness, and sensitive-content redaction.

## Review Findings and Fixes

- Reused `GovernedMemoryReader.checkEligibility` as the canonical current-revision eligibility authority.
- Stored snapshot membership is limited to ordered `(memory_id, revision_id)` identities; no content or SQLite transaction crosses into the host registry.
- Fixed exact candidate-space omitted counts instead of returning a lower-bound placeholder.
- Fixed sensitive content handling across list, detail, history, and evidence provenance.
- Fixed an ambiguous zero-item outcome: a truncated raw candidate scan can no longer be reported as complete governance exclusion.
- Added deterministic cycle detection for returned provenance edges.
- No Trellis spec update was required; the implementation follows the existing strict-contract, one-writer, content-free-diagnostic, and cross-layer rules.

## Passing Gates

- `pnpm lint`
- All runtime package builds through `pnpm build:runtime`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm exec vitest run tests/contract/workbench.contract.test.ts tests/storage/workbench-reader.integration.test.ts tests/integration/workbench-service.test.ts tests/governance/correction.integration.test.ts tests/storage/projection-schema.integration.test.ts`
  - 5 files, 48 tests passed.
- `git diff --check`
- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-02-memory-workbench`

## Full-Suite Exceptions

`pnpm test` completed with 142 of 146 test files passing and 729 tests passing. The seven failures are outside U1:

- G5/G6 frozen artifact and implementation-digest gates reject the intentionally dirty feature worktree and changed tested-implementation digest. These release artifacts must not be regenerated for a partial implementation unit.
- `tests/integration/operator-cli.integration.test.ts` reports `KEY_UNAVAILABLE` in the inherited private-descriptor admission scenario. The same test fails in isolation and does not exercise the Workbench read path.

These exceptions remain visible for final release verification; they are not represented as passing.
