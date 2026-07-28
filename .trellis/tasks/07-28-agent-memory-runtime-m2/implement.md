# M2 Implementation Checklist

## 0. Task gate

- [x] Validate the M2 Trellis task and activate it on
      `codex/agent-memory-runtime-m2`.
- [x] Load M2 PRD, design, plan, research handoff, and relevant Trellis specs.
- [x] Confirm Node 24.18.0 and the current frozen dependency lock.
- [x] Preserve M1B/G1 as the regression baseline.

## 1. U1 — governance contracts first

- [x] Add failing contract tests for candidate, admission, revision, lifecycle
      event, user-control, approval-reference, and purge artifacts.
- [x] Add failing input tests for propose/correct/pin/demote/usage/revoke/delete
      and dry-run/CAS requirements.
- [x] Extend receipt/status schemas with stale-revision,
      stale-tombstone-frontier, and incomplete-purge outcomes.
- [x] Preserve canonical JSON/hash replay for all existing artifacts.
- [x] Validate with:
      `pnpm test:contract -- governance.contract.test.ts`.
- [x] Commit U1 only after its focused tests, lint, and typecheck pass.

## 2. U2 — SQLite governance schema

- [x] Add immutable migration `0004-l1-governance.sql`.
- [x] Add immutable migration `0005-tombstone-purge.sql`.
- [x] Add strict constraints/triggers for immutable revision and append-only
      event/receipt history.
- [x] Add a narrow purge-job guard for exclusive content-only L0/L1/Context
      redaction while preserving identity/hash/lineage/receipt fields.
- [x] Add governance and purge repositories behind the storage worker.
- [x] Add decoded worker operations and storage health counts/frontiers.
- [x] Prove forward migration, restart, immutability, reference counts, and
      monotonic tombstone epoch.
- [x] Validate with:
      `pnpm test:storage -- governance-schema.integration.test.ts`.
- [x] Commit U2 only after storage, recovery, lint, and typecheck pass.

## 3. U3 — admission, identity, conflict, CAS

- [x] Write failing admission-matrix fixtures, including prompt injection and
      foreign/deleted evidence.
- [x] Implement deterministic logical key/content identity and exact duplicate
      reuse.
- [x] Add forward migration `0006-governance-commands.sql` for replay snapshots
      and many-candidate/nullable-conflict links without changing 0004/0005.
- [x] Implement conflict groups without destructive upsert.
- [x] Implement one-transaction activation/revision CAS, idempotency, outbox,
      epoch, and receipt.
- [x] Prove one winner/one stale result for concurrent successors.
- [x] Prove retry returns the same receipt and changed request hash conflicts.
- [x] Prove a same-hash replay succeeds after its approval is consumed.
- [x] Validate with:
      `pnpm vitest run tests/governance/admission.integration.test.ts tests/governance/revision-cas.integration.test.ts`.
- [x] Commit U3 only after focused plus storage regression tests pass.

## 4. U4 — correction and governed Context

- [x] Write failing correction-before-projection and stale-FTS fixtures.
- [x] Add the canonical eligibility oracle for search/get/explain/Context.
- [x] Extend Context candidates to represent governed L1 revisions while
      preserving L0 fallback and hard token budgets.
- [x] Implement synchronous predecessor suppression and async invalidation.
- [x] Add governed L1 FTS upsert/delete/rebuild behavior.
- [x] Prove every invalid lifecycle/validity/conflict/usage state has a stable
      exclusion reason.
- [x] Validate with:
      `pnpm vitest run tests/governance/correction.integration.test.ts tests/mcp/context-compiler.test.ts`.
- [x] Commit U4 only after MCP, Context, storage, lint, and typecheck pass.

## 5. U5 — user controls and MCP authorization

- [ ] Write failing server-side approval and user-control parity tests.
- [ ] Implement trusted approval-registry verification and one-time
      consumption.
- [ ] Enforce absolute path, non-symlink, owner/mode, schema, and manifest
      digest checks for the local approval adapter.
- [ ] Replay an already committed same-hash idempotency record before requiring
      a new approval; consume new approvals with the canonical transaction.
- [ ] Implement dry-run with zero canonical mutation and no approval
      consumption.
- [ ] Change destructive configuration to an explicit boolean that remains
      false by default; require enablement plus approval for delete.
- [ ] Implement pin, demote, scoped/global usage block, and revoke as distinct
      operations.
- [ ] Register propose/correct/control/delete MCP tools with frozen safety
      metadata.
- [ ] Prove runtime and MCP paths produce equivalent governed outcomes.
- [ ] Prove missing/expired/reused/forged/wrong-scope/wrong-tool/wrong-hash
      approvals fail before mutation.
- [ ] Prove delete is unavailable under the default server configuration.
- [ ] Validate with:
      `pnpm vitest run tests/mcp/governance-mutations.integration.test.ts tests/security/mutation-authorization.test.ts`.
- [ ] Commit U5 only after MCP/security/lint/typecheck pass.

## 6. U6 — tombstone and Purge Saga

- [ ] Write failing exclusive/shared purge and interrupted-retry fixtures.
- [ ] Implement synchronous tombstone epoch and retryable purge job.
- [ ] Implement per-store outcomes for revision/candidate/conflict, FTS,
      Context overlay, export/cache inventory, blobs, backup/frontier, and
      projection consumers.
- [ ] Scrub unshared governed plaintext/blob references while preserving
      content-free audit identity and hashes.
- [ ] Redact exclusive L0/Context payloads through the purge guard and prove
      ordinary append-only updates remain blocked.
- [ ] Preserve shared live references as named residual debt.
- [ ] Prove complete purge has zero residual and incomplete purge cannot be
      represented as complete.
- [ ] Prove FTS rebuild/restart cannot resurrect deleted content.
- [ ] Validate with:
      `pnpm vitest run tests/governance/purge.integration.test.ts tests/recovery/purge-retry.recovery.test.ts tests/security/deleted-content-residual.test.ts`.
- [ ] Commit U6 only after governance/recovery/security regression tests pass.

## 7. U7 — backup/restore tombstone frontier

- [ ] Add tombstone epoch to backup evidence and stored manifest.
- [ ] Require a trusted minimum frontier in restore.
- [ ] Reject stale/corrupt snapshots before publishing the destination.
- [ ] Run integrity, migration, blob, eligibility, and residual verification on
      staging.
- [ ] Prove passing current restore and failing pre-delete restore.
- [ ] Validate with:
      `pnpm vitest run tests/recovery/stale-tombstone-restore.recovery.test.ts tests/storage/fts-and-backup.integration.test.ts`.
- [ ] Commit U7 only after storage/recovery regression tests pass.

## 8. U8 — G2 evidence

- [ ] Add end-to-end L1 governance loop and frozen replay fixtures.
- [ ] Run admission, correction, controls, deletion, restart, retry, projection
      lag, purge debt, and stale restore on one tested commit.
- [ ] Run prompt-injection, scope, approval-forgery, and sensitive-log checks.
- [ ] Run all M0/M1/G1 regressions.
- [ ] Run:
      `pnpm install --frozen-lockfile`,
      `pnpm lint`,
      `pnpm typecheck`,
      `pnpm build`,
      `pnpm test`,
      and `pnpm audit --audit-level=high`.
- [ ] Record test counts, hashes, performance, residuals, debt, and explicit
      `GO`/`HOLD` in `docs/evaluations/g2-decision.md`.
- [ ] Record the tested implementation commit before the evidence-only commit;
      do not change executable code or frozen fixtures afterward.
- [ ] Update MCP and operator documentation.
- [ ] Commit U8/G2 only after all evidence references the final tested commit.

## 9. Review and finish

- [ ] Run Trellis full-scope check against PRD/design/implementation criteria.
- [ ] Review correctness, data integrity, security, recovery, API contracts,
      test coverage, maintainability, and project standards.
- [ ] Resolve every P0/P1 finding and rerun affected suites.
- [ ] Update Trellis specs only for durable new conventions.
- [ ] Commit all remaining scoped documentation/evidence.
- [ ] Archive M2 only after G2 evidence is complete and journal the commit.
- [ ] Do not open M3 when G2 is `HOLD`.
