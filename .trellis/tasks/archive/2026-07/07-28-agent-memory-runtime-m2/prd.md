# Agent Memory Runtime M2 versioned L1 governance

## Goal

Implement evidence-derived L1 admission, immutable revisions, compare-and-swap
correction, distinct user controls, tombstone-first deletion, and a verifiable
Purge Saga, then close G2 with zero stale resurrection.

## Authority

1. Product Contract R2, R3, R5-R8, R11-R15, R19-R20; F1/F3;
   AE2/AE4/AE8.
2. Parent M2/G2 roadmap and architecture.
3. M2 research run
   `RUN20260728-231007-m2-governance-implementa-8ca6a5`.
4. `docs/plans/2026-07-28-002-feat-versioned-l1-governance-plan.md`.

This child does not add or renumber product requirements.

## In scope

- Persisted L1 candidates, logical memories, immutable revisions, evidence
  lineage, admission decisions, conflicts, suppression/status events, pin and
  Context-usage overlays.
- Deterministic admission based on persisted evidence authority, sensitivity,
  exact scope, inference, conflict, and injection risk.
- Stable logical identity, exact duplicate reuse, conflict groups, and
  expected-revision CAS.
- Important/destructive user controls: correction, pin, demote, usage block,
  revoke, and delete.
- Server-side principal/scope/destructive-policy checks plus request-bound,
  one-time approval verification from an out-of-band local registry.
- Destructive tools remain disabled by default; delete requires explicit local
  enablement in addition to per-invocation approval.
- Governed L1 search/get/explain/Context eligibility with post-projection
  canonical revalidation.
- Tombstone epoch, invalidation jobs, retryable Purge Saga, complete/incomplete
  purge receipts, and shared-lineage debt.
- Governed FTS invalidation/rebuild, Context redaction/eligibility overlays,
  blob reference audit, and export/cache inventory.
- Backup evidence with tombstone epoch and restore fail-closed against a
  trusted minimum.
- Frozen G2 integration, replay, recovery, security, and privacy evidence.

## Out of scope

- L2/L3 topic, scenario, relation, or core projection implementations.
- Graph or vector adoption.
- Learning evaluation, canary, release, or rollback.
- Fleet-wide tombstone-frontier distribution and richer approval UI.
- Remote transport, multi-user identity, OAuth, or remote storage.
- Rewriting old migrations, mutating historical hashes, or making a
  projection authoritative.

## Invariants

- SQLite is the sole canonical authority; L0 evidence remains the provenance
  root.
- Active L1 requires live evidence lineage and a persisted activation
  decision.
- Every successor names the exact predecessor and advances the pointer only
  with successful CAS.
- Identical idempotency key plus request hash returns the same receipt;
  different hash returns `CONFLICT`.
- Correction/revoke/delete changes online eligibility in the canonical
  transaction before projection cleanup.
- Pin never overrides validity, authority, conflict, revoke, tombstone, or
  Context usage policy.
- MCP annotations and input claims never authorize a mutation.
- A committed same-hash retry replays before new-approval verification; a
  changed request cannot reuse the consumed approval or idempotency key.
- Delete suppresses immediately; purge completeness is never claimed while
  residual content or an unchecked store remains.
- Restore cannot publish a snapshot behind the trusted tombstone frontier.
- M1B's L0 explicit loop remains a tested safe fallback.

## Acceptance Criteria

- [x] Every active L1 revision has live exact-scope evidence and a persisted
      `AdmissionDecision`.
- [x] User-stated safe evidence can activate; inferred/derived evidence stays
      candidate-only; injection-like procedural content quarantines; invalid
      lineage rejects.
- [x] Exact duplicates reuse identity and divergent normalized-key content
      forms a conflict without replacing the current revision.
- [x] Concurrent successors from one expected revision produce one success and
      one `STALE_REVISION`.
- [x] Correction suppresses the predecessor before outbox/FTS processing.
- [x] Pin, demote, scoped/global usage block, revoke, and delete pass distinct
      behavior tests.
- [x] Missing, forged, expired, reused, wrong-scope, wrong-tool, and
      wrong-request-hash approvals change no canonical state.
- [x] Delete is unavailable under the default configuration and requires both
      explicit local enablement and a valid per-invocation approval.
- [x] Approval manifests with unsafe path/owner/mode/symlink/digest state fail
      closed; a committed same-hash retry still replays after consumption.
- [x] Dry-run changes no canonical epoch/current pointer and does not consume
      approval.
- [x] Stale FTS hits and expired/superseded/quarantined/revoked/tombstoned
      revisions cannot enter a new Context slice.
- [x] Exclusive purge reports complete with zero canonical/FTS/Context/blob/
      export residual; shared lineage reports incomplete debt while remaining
      tombstoned.
- [x] Purge-authorized content scrub cannot mutate identity/hash/lineage/
      receipt fields, and ordinary writes still cannot update append-only
      evidence or Context history.
- [x] Duplicate correction/delete requests replay the same effect and receipt;
      interrupted purge resumes the same job.
- [x] FTS rebuild and process restart cannot resurrect corrected or deleted
      content.
- [x] Restore rejects a backup below the trusted tombstone frontier and
      publishes no target data root.
- [x] Security/privacy tests find no cross-scope result, approval bypass,
      prompt-injection activation, or sensitive diagnostic content.
- [x] M0/M1/G1 regression, lint, typecheck, build, frozen install, dependency
      audit, and relevant performance checks remain green on Node 24.18.0.
- [x] `docs/evaluations/g2-decision.md` records current hashes, test counts,
      purge/frontier evidence, debt, and explicit `GO` or `HOLD`.

## Hold and rollback

Any tombstone resurrection, authorization bypass, lost update, or unverifiable
purge blocks G2. Freeze new admission and serve only L0 or last verified
read-only L1 revisions. Optional projection work remains closed.
