# Agent Memory Runtime M6 Operational Hardening

## Goal

Deliver the final local operational-hardening milestone: diagnosable startup
and degradation, complete frontier-aware backup/restore, governed secret
encryption and key lifecycle, WAL/disk/backpressure controls, deterministic
repair and purge audit, redacted observability, exercised runbooks, and one
verifier-backed G6 decision.

## Product Authority

The sole product numbering is R1-R20, F1-F4, and AE1-AE8 in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md`.
The scoped M6 interpretation is
`docs/brainstorms/2026-07-30-m6-operational-hardening-requirements.md`.
This child does not add another requirement namespace.

## Confirmed Baseline

- SQLite remains the sole canonical authority and one storage worker owns
  writes.
- G3R is `GO`; G4A graph and G4B vector remain `NO-GO`.
- G5 is `GO` only for the exact local synthetic release path; automatic
  publication stays disabled.
- Current backup/restore already checks tombstone and learning frontiers, uses
  an empty staging root, verifies blobs/integrity, and degrades graph/vector
  state after restore.
- Data-root directories/files use `0700`/`0600`, but `secret` content still
  fails closed pending M6 application encryption and key lifecycle.
- No `apps/` or operator CLI currently exists. Operational behavior is spread
  across package APIs, tests, and milestone-specific docs.

## Requirements

- Provide one local operator boundary for doctor, backup, restore, rebuild,
  purge audit, and release verification without exposing offline/destructive
  repair as routine MCP mutation.
- Bind backup and restore to schema, ledger, tombstone, purge, FTS/layered,
  Context, learning release/control, encrypted-artifact, and receipt
  frontiers; publish only a verified new empty root.
- Keep graph/vector disabled and absent/inert derived state non-blocking.
- Implement application encryption and a crash-safe bounded key lifecycle for
  authorized `secret` canonical content; never fall back to plaintext.
- Preserve current rejection of network/shared/removable/cloud-synchronized
  data roots.
- Detect disk/WAL/queue/checkpoint pressure before unsafe writes; apply typed
  backpressure, read-only, degraded, or blocked states with recovery criteria.
- Make startup/doctor output content-free, machine-readable, and sufficient to
  explain schema, capacity, canonical frontiers, projection state, purge debt,
  learning state, encryption/key state, and next safe action.
- Exercise worker crash, transaction interruption, migration interruption,
  backup corruption, stale restore, wrong key, derived corruption, disk
  exhaustion, partial purge, monitor breach, and rollback failure.
- Provide deterministic FTS/layered rebuild and content-free purge-audit
  evidence without enabling graph/vector.
- Ensure default logs, metrics, diagnostics, errors, evidence, temporary
  paths, and quarantine contain no memory/Context/tool/secret/key/deleted
  plaintext markers or full data-root paths.
- Make runbooks executable and bind their observations to the exact candidate.
- Record G6 `GO` only if every frozen integrity, privacy, deletion,
  encryption, recovery, resource, supply-chain, review, and runbook hard rule
  passes. Otherwise record supported `NO-GO` and the last verified fallback.

## Acceptance Criteria

- [ ] Doctor distinguishes ready, degraded, read-only, repairable, and blocked
      states without raw content.
- [ ] Current backup/restore produces behavioral equivalence at every required
      frontier; stale/tampered/incomplete/wrong-key snapshots never publish.
- [ ] Secret admission, recall, backup, restore, rotation, wrong-key startup,
      and purge are encrypted, authorized, crash-safe, and marker-free.
- [ ] Disk/WAL/queue/checkpoint pressure blocks unsafe writes before partial
      canonical effects and preserves typed reads where safe.
- [ ] Interrupted migration and repair either expose the complete old or
      complete new state, never a serveable mixed state.
- [ ] FTS/layered corruption rebuilds from SQLite; graph/vector remain
      disabled and non-required.
- [ ] Tombstoned/purged content cannot return through canonical rows, Context,
      projections, learning artifacts, backups, temporary/quarantine files,
      logs, or restore.
- [ ] A restored G5 release/control frontier preserves pause and exact
      rollback with no candidate resurrection.
- [ ] Every operator mutation is dry-runnable where meaningful, explicitly
      confirmed when destructive, idempotent/replayable, and receipt-bearing.
- [ ] Fault tests, security scans, resource evidence, full repository gates,
      supply-chain audit, required reviews, and runbook exercises are green or
      force G6 `NO-GO`.
- [ ] G6 records tested implementation/evidence/decision commits, lock/schema/
      platform/configuration identities, first false hard rule if any,
      limitations, active release/fallback, and rerun boundary.
- [ ] No cloud sync, multi-user/fleet service, graph/vector reopening,
      production traffic, or universal production SLO claim is introduced.

## Out of Scope

- Remote/cloud backup, sync, shared/removable/network data roots, or
  cross-device merge.
- Multi-user authorization, HA, distributed recovery, web dashboard, or
  enterprise administration.
- General-purpose secret management or protection from the process owner/host
  administrator.
- Physical block-erasure guarantees on copy-on-write media.
- Graph/vector reevaluation, automatic learning publication, model training,
  new candidate types, or product-code self-modification.
- General Codex Host Adapter automation and production fleet rollout.

## Planning Gate

Before `task.py start`, M6 must complete:

- `ce-brainstorm` requirements and this converged PRD;
- a `research-to-article` RQ/Claim/Evidence handoff;
- `ce-plan` design and complete implementation checklist;
- curated Trellis implement/check context;
- document review with zero unresolved P0/P1;
- an explicit planning summary. The continuous-roadmap authorization permits
  headless continuation, but every inferred product bet remains visible in the
  requirements and planning artifacts.

## Notes

- Every completed brainstorm, research, plan, implementation unit, evidence
  capture, decision, archive, and journal is one commit.
- M6 follows
  `ce-brainstorm → research-to-article → ce-plan → ce-work` under Trellis.
