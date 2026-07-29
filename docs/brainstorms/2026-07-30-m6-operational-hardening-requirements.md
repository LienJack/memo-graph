---
date: 2026-07-30
topic: m6-operational-hardening
---

# M6 Operational Hardening Requirements

## Summary

Turn the accepted local Agent Memory Runtime into a diagnosable, recoverable,
resource-bounded release candidate with governed secret handling, exercised
failure recovery, operator runbooks, and one evidence-backed G6 decision.

---

## Problem Frame

M0-M5 established strict contracts, SQLite authority, an MCP loop, governed
memory lifecycle, layered Context, optional-lane decisions, and reversible
learning. Those gates prove the individual mechanisms and frozen test
distributions. They do not yet prove that an operator can safely run the
combined runtime through disk exhaustion, WAL growth, interrupted upgrades,
corrupt derived state, stale backups, key loss, partial purge, or a failed
learning release.

Important operational behavior is currently split across library calls,
tests, and milestone-specific notes. Backup and restore already preserve
several frontiers, but there is no unified operator contract that explains
whether the whole runtime is healthy, which degraded mode is active, what
must be rebuilt, or whether a snapshot may be served. Secret content still
fails closed because the M0 data-at-rest decision deferred application-level
encryption and key lifecycle to M6.

Without an exercised operational boundary, a green feature suite could still
ship a runtime that loses rollback state, serves a stale tombstone frontier,
leaks memory through diagnostics, accepts writes while storage is unsafe, or
requires undocumented manual repair. G6 must judge those combined failure
modes rather than infer readiness from earlier gates.

---

## Assumptions

*This requirements document was authored under the user's continuous-roadmap
authorization without synchronous M6 confirmation. The items below are
unvalidated agent bets that research, document review, and planning must
scrutinize before implementation begins.*

- A thin local command-line operator surface is the primary interface for
  doctor, backup, restore, rebuild, purge audit, and release verification.
  Destructive or offline repair is not exposed as a routine MCP mutation.
- M6 implements application-level encryption and a bounded local key
  lifecycle for `secret` canonical content. It does not weaken the existing
  rejection of shared, removable, network, or cloud-synchronized data roots.
- G6 may be `GO` only for the exact tested platform, dependency lock,
  filesystem assumptions, data-root policy, schema, and accepted G3R/G4A/
  G4B/G5 configuration.
- The supported M6 topology remains one local user, one local data root, one
  serialized SQLite writer, and local stdio MCP. Multi-process failover and
  remote coordination are not required.
- Graph and vector remain disabled under G4A/G4B `NO-GO`. M6 verifies that
  their inert or absent derived state never blocks backup, restore, purge, or
  supported runtime startup.
- M6 preserves automatic learning publication as disabled. It hardens the
  G5-qualified release/control frontier without turning synthetic G5 evidence
  into a production rollout.
- Operational metrics and diagnostics use existing runtime dependencies unless
  research proves that a new dependency is necessary and safe.

---

## Actors

- A1. Local operator / memory owner: creates and verifies backups, supplies
  trusted frontiers and keys, runs diagnostics and repair, approves destructive
  actions, and decides whether the tested release may be used.
- A2. Codex Agent: continues using the MCP memory contract and must receive
  typed safe degradation rather than corrupt, stale, or ambiguous Context.
- A3. Memory Runtime: owns canonical SQLite state, encrypted local content,
  frontiers, health, backpressure, repair orchestration, and content-free
  operational evidence.
- A4. Release evaluator: runs the frozen fault, recovery, security, resource,
  and runbook matrix and records exactly one G6 `GO` or supported `NO-GO`.

---

## Key Flows

- F1. Start and diagnose the local runtime
  - **Trigger:** A1 starts the runtime, observes degradation, or requests a
    pre-release health check.
  - **Actors:** A1, A3
  - **Steps:** Validate local path and permissions; inspect schema, WAL,
    capacity, canonical frontiers, projection status, purge debt, learning
    release/control state, and key availability; return a machine-readable
    state plus bounded operator guidance.
  - **Escape path:** Unsafe canonical state, missing required key material,
    stale frontiers, or unbounded disk pressure blocks writes or serving as
    appropriate; optional derived failure selects a named safe fallback.
  - **Outcome:** A1 can distinguish healthy, degraded, read-only, repairable,
    and blocked states without reading raw memory content.
  - **Covered by:** R1-R3, R5-R7, R10-R13, R19-R20

- F2. Create and restore a complete governed snapshot
  - **Trigger:** A1 requests a backup or recovery into a new empty data root.
  - **Actors:** A1, A3
  - **Steps:** Quiesce or establish a consistent snapshot frontier; capture
    canonical and encrypted artifacts plus schema, tombstone, purge,
    projection, learning release/control, and key identities; verify the
    snapshot; restore into staging; compare against trusted external minimum
    frontiers; rebuild disposable state; publish only after verification.
  - **Escape path:** A stale, incomplete, tampered, unreadable, wrong-key, or
    non-atomic snapshot never replaces or publishes the target root.
  - **Outcome:** A restored root is behaviorally equivalent at the named
    frontier, or remains absent with a typed failure and intact source root.
  - **Covered by:** R2-R9, R14-R20

- F3. Degrade and recover under operational faults
  - **Trigger:** Disk capacity falls, WAL/checkpoint stalls, a worker crashes,
    migration is interrupted, or derived state becomes corrupt/unavailable.
  - **Actors:** A1-A3
  - **Steps:** Detect the condition; protect canonical invariants; apply
    bounded backpressure or read-only/blocking behavior; preserve typed MCP
    status; restart, replay, rebuild, or restore; verify convergence before
    lifting the restriction.
  - **Escape path:** If safe automated recovery cannot be proven, preserve the
    last verified canonical state and require an explicit operator action.
  - **Outcome:** Faults cannot silently become empty recall, partial canonical
    effects, deletion resurrection, or learned-release drift.
  - **Covered by:** R1, R5-R6, R9-R15, R17-R20

- F4. Audit deletion and residual state
  - **Trigger:** A1 requests a purge audit, a purge job remains partial, or a
    backup/restore is considered for publication.
  - **Actors:** A1, A3
  - **Steps:** Enumerate every registered canonical, derived, backup, log,
    temporary, quarantine, and encrypted artifact class; validate receipts and
    residual hashes; retry only authorized work; compact/checkpoint as needed;
    report content-free proof.
  - **Escape path:** Any missing store outcome, unreadable artifact, plaintext
    residual, or inconsistent receipt blocks purge completion and G6.
  - **Outcome:** Deleted content is not model-visible or recoverable through a
    supported runtime path, while necessary audit identity remains.
  - **Covered by:** R2-R3, R6-R8, R14-R15, R19-R20

- F5. Admit, use, rotate, and remove secret content
  - **Trigger:** A1 stores authorized `secret` content, rotates/replaces the
    local key, restores an encrypted snapshot, or deletes the secret.
  - **Actors:** A1, A3
  - **Steps:** Require explicit authority and available key material; encrypt
    before durable storage; bind ciphertext to canonical identity and scope;
    decrypt only inside an authorized operation; rotate through a crash-safe
    transition; verify deletion and ciphertext residual policy.
  - **Escape path:** Missing, wrong, expired, or ambiguous key state fails
    closed without plaintext fallback or destructive guessing.
  - **Outcome:** Secret content can participate in authorized canonical memory
    without entering plaintext backups, logs, diagnostics, projections, or
    temporary files.
  - **Covered by:** R2-R3, R6-R7, R10-R15, R18-R20

- F6. Execute the final release gate
  - **Trigger:** M6 implementation, review, runbooks, and frozen evidence are
    complete, or the first unrecoverable hard-stop is observed.
  - **Actors:** A1, A4
  - **Steps:** Bind the exact source, lock, schema, platform, configuration,
    fixtures, thresholds, reports, prior gate decisions, release/control
    frontiers, and unresolved debt; run every hard rule; independently verify
    evidence; record one decision.
  - **Escape path:** Any missing evidence or unresolved P0/P1 integrity,
    privacy, deletion, encryption, restore, or rollback issue forces G6
    `NO-GO`.
  - **Outcome:** The roadmap ends with an auditable local release baseline or
    an explicit experimental fallback and rerun boundary.
  - **Covered by:** R1-R20

---

## Requirements

The Product Contract in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md` remains the
only R-number authority. The bullets below are M6 operational interpretations;
they do not add or renumber product requirements.

**Local ownership, operator control, and secret data**

- R1. The MCP runtime must remain independently operable while M6 adds an
  explicit local operator boundary for diagnosis and offline recovery.
- R2. Canonical data, backups, temporary repair state, diagnostics, and release
  evidence must preserve the local-data boundary; `secret` content requires
  verified application-level encryption before durable admission.
- R3. The local user remains final authority for key use, destructive restore,
  purge retry, release activation, and rollback; payloads and repair commands
  cannot self-authorize.

**Layer, lifecycle, and projection recovery**

- R4. Backup, restore, doctor, and release evidence must cover the complete
  accepted L0/L1/L2/L3 topology rather than treating the ledger alone as the
  whole runtime.
- R5. Health and recovery must expose lifecycle/frontier states that
  distinguish pending, degraded, rebuilding, read-only, blocked, and ready
  behavior.
- R6. Canonical records, derived projections, frozen Context, learning
  candidates, backups, logs, and temporary repair artifacts remain distinct
  operational classes with explicit ownership and recovery policy.
- R7. Every restored or rebuilt model-visible item must still resolve to live
  canonical identity, scope, validity, lifecycle, provenance, and authority at
  the restored frontier.
- R8. Higher-layer relations remain rebuildable from SQLite. The G4A graph
  `NO-GO` is preserved, and absent/inert graph state cannot become a backup or
  startup dependency.
- R9. The G4B vector `NO-GO` is preserved. Vector state remains disabled and
  optional; its absence cannot weaken supported FTS/recency/layered/SQLite
  recovery.

**Bounded service and actionable degradation**

- R10. Runtime startup, queueing, checkpoint, backup, rebuild, and repair must
  have explicit capacity, time, and concurrency bounds; disk pressure applies
  deterministic backpressure before unsafe writes.
- R11. Operator and MCP health results must include sufficient content-free
  identity, frontier, component, reason, and recovery information to explain
  the current state.
- R12. Corrupt, stale, incomplete, or unavailable derived state must never
  bypass canonical filters or contaminate Context; the supported runtime uses
  the last verified baseline or a typed fallback.
- R13. No match, policy exclusion, optional-lane degradation, canonical
  read-only mode, retryable storage pressure, corruption, and unrecoverable
  failure must remain distinct and actionable.

**Correction, deletion, audit, and restore safety**

- R14. Correction, pin/demote/usage controls, revoke, tombstone, purge, and
  learning pause/rollback effects must survive restart, backup, restore,
  migration, rebuild, and fault recovery before serving.
- R15. Operational repair must never silently rewrite immutable history.
  Purge may retain only approved identifiers, hashes, states, and receipts;
  plaintext or decryptable deleted content must not survive in supported
  artifact classes.

**Learning frontier and final evidence**

- R16. Task evidence and learning candidates remain distinct from operational
  metrics; backup/restore must not convert candidate-only state into an active
  release.
- R17. The G5-qualified release, monitor, pause/resume, and exact rollback
  chain must retain its immutable identities and pointer semantics through
  restart, snapshot, migration, and restore.
- R18. Missing approval or key authority must fail closed while ordinary
  authorized non-learning memory reads remain available whenever canonical
  integrity permits.
- R19. Every operational action that changes serving eligibility, canonical
  state, key state, snapshot state, or release state must produce replayable
  content-free evidence bound to the exact request and result.
- R20. G6 must use frozen fault, recovery, security, resource, and runbook
  checks. Any unresolved integrity, privacy, deletion, encryption, restore, or
  rollback hard rule forces `NO-GO`; aggregate success cannot compensate.

---

## Acceptance Examples

- AE1. **Covers R4, R7, R10, R11, R14.** Given an accepted multi-session
  preference and project constraint, when a current snapshot is restored and
  the runtime restarts, the same governed items and explanations are available
  within budget without replaying entire transcripts.
- AE2. **Covers R5, R7, R12, R14.** Given a corrected fact plus stale
  projection files, when recovery runs after an interrupted rebuild, only the
  current revision becomes model-visible and the stale projection is reported
  as degraded or rebuilt.
- AE3. **Covers R8-R10, R12.** Given graph/vector remain disabled, when the
  data root is backed up, restored, and rebuilt, FTS/recency/layered/SQLite
  relations continue without model/index installation or optional-process
  startup.
- AE4. **Covers R8, R14-R15, R19-R20.** Given a deleted fact once referenced by
  Context, projections, a learning candidate, and an older backup, when purge
  audit and stale-restore tests run, no supported path can serve the deleted
  content and every residual has a verified outcome.
- AE5. **Covers R11-R13.** Given one true no-match, one optional projection
  outage, one low-disk write block, and one corrupt canonical database, when
  A1/A2 inspect results, each has a distinct state and safe action; none is
  reported as an empty memory history.
- AE6. **Covers R16-R20.** Given the G5-qualified learned release, when a
  snapshot captures it and a monitor breach is injected after restore, the
  exact authorized rollback restores the named base pointer without changing
  graph/vector decisions.
- AE7. **Covers R17-R19.** Given learning is paused before backup, when the
  snapshot is restored, ordinary governed recall and authorized writes still
  work while candidate generation, canary, and publication remain blocked at
  the restored control frontier.
- AE8. **Covers R2-R3, R14-R15, R18-R20.** Given authorized secret content,
  when backup, restore, diagnostics, key rotation, wrong-key startup, and purge
  tests run, plaintext never appears in persisted artifacts or logs; wrong-key
  state fails closed; authorized deletion leaves no supported decryptable
  result.

---

## Success Criteria

- A local operator can determine whether the runtime is ready, degraded,
  read-only, repairable, or blocked and can identify the next safe action
  without inspecting memory content or SQLite manually.
- A verified backup restores into a new empty root with equivalent canonical,
  tombstone, purge, projection, Context, learning release/control, and
  encrypted-artifact frontiers; stale or tampered backups never publish.
- Disk/WAL pressure, worker crash, interrupted migration, derived corruption,
  partial purge, missing key, wrong key, and rollback failure are exercised
  with deterministic safe states and recovery Oracles.
- Secret content is never durably written in plaintext and can be rotated,
  backed up, restored, and purged through an explicit bounded key lifecycle.
- Default diagnostics, logs, runbook output, errors, evidence reports, and
  temporary/quarantine paths contain no memory, Context, tool, secret, key, or
  deleted plaintext markers.
- Every runbook is executable against the tested release and its expected
  observations are included in the final evidence bundle.
- G6 records exactly one verifier-backed `GO` or supported `NO-GO`, names the
  first false hard rule, and keeps the accepted fallback independently
  runnable.
- Downstream research and planning can trace every operational unit to the
  existing R1-R20, F1-F4, AE1-AE8, accepted gate decisions, and explicit M6
  assumptions without inventing product behavior.

---

## Scope Boundaries

- No cloud sync, remote backup service, network filesystem, shared/removable
  data root, or cross-device merge.
- No multi-user authorization, daemon cluster, high availability, leader
  election, or distributed transaction.
- No web dashboard or general administrative control plane.
- No general-purpose secret manager. M6 supports only the bounded key
  lifecycle needed by the local runtime and does not protect against a
  compromised process owner or host administrator.
- No attempt to guarantee physical block erasure on copy-on-write media.
  Supported guarantees are logical ineligibility, enumerated residual checks,
  encryption where required, and cryptographic erasure only when its key
  contract is satisfied.
- No reopening graph/vector selection or substituting another candidate.
- No production traffic, fleet canary, multi-platform certification, or
  universal production SLO claim from local synthetic fault evidence.
- No automatic learning publication, new learning candidate type, model
  training, prompt/code self-modification, or broad capability release.
- No unrelated UI, Codex Host Adapter automation, or enterprise packaging.

---

## Key Decisions

- G6 is a combined-system gate, not a summary of earlier green suites. It must
  exercise cross-frontier failure and recovery on one immutable candidate.
- Safe service outranks write availability. When capacity, key, migration, or
  integrity preconditions fail, the runtime narrows behavior before risking a
  partial or unverifiable write.
- Canonical and derived recovery remain asymmetric: SQLite is restored and
  verified; FTS/layered projections are rebuilt; graph/vector stay disabled.
- Restore is publish-new-root only. M6 does not overwrite a live root in place.
- Operational observability is content-free and receipt-linked. Logs and
  metrics are hints, never the audit authority.
- Secret support adds encryption without widening filesystem trust. Existing
  untrusted-volume rejection remains the supported default.
- Runbooks are tests with human-readable instructions: a G6 claim requires
  both automated assertions and exercised operator steps.
- G6 `NO-GO` is a complete outcome. The runtime remains local experimental,
  and the first failed hard rule plus last verified fallback are preserved.

---

## Dependencies / Assumptions

- Baseline branch:
  `codex/agent-memory-runtime-m5` at
  `de1a4db3bfdd11446cd14687676c099afcacfadf`.
- Accepted runtime decisions:
  - G3R `GO` at `6224f782c86712488d416d8101ef7c9fa477c0ae`;
  - G4A graph `NO-GO` at
    `36421f5cd75007a1421d3e0594e7881dd4b864b2`;
  - G4B vector `NO-GO` at
    `3eec7119b1e441d76523d0a57c328d4d811a4af3`;
  - G5 learning `GO` on tested implementation
    `91d810efe17632e64f5e9a3ddae81f8e9f0b9985`, evidence commit
    `b9c0907745cedf3315d7ab3f42a39c9afb8790eb`, and decision
    `docs/evaluations/g5-decision.md`.
- Node `24.18.0`, the exact pnpm lock, TypeScript strict ESM,
  `better-sqlite3`, SQLite WAL, the dedicated storage worker, canonical hashes,
  and one local filesystem remain the baseline unless research finds a
  blocking incompatibility.
- Existing backup/restore, health, purge, FTS/layered rebuild, graph/vector
  fallback, and learning frontier behavior are starting evidence, not proof of
  final combined-system readiness.
- The user has authorized continuous roadmap execution and one commit per
  completed logical task. Brainstorm, research, plan, implementation units,
  evidence, decision, archive, and journal remain separate commits.

---

## Outstanding Questions

### Resolve During Research

- [Affects R2-R3, R15, R18-R20][Needs research] What minimal local
  application-encryption and key-lifecycle contract survives crash, rotation,
  backup, restore, wrong-key startup, purge, and OS/process limitations without
  becoming a general secret manager?
- [Affects R4-R9, R14-R20][Needs research] Which exact schema, tombstone,
  purge, projection, Context, release/control, encryption, and artifact
  frontiers must a complete backup manifest bind, and which derived state must
  be rebuilt rather than copied?
- [Affects R5, R10-R13, R20][Needs research] Which WAL, disk-capacity,
  queue-age, checkpoint, backup, rebuild, and repair thresholds are defensible
  for the frozen Small/Expected workloads, and how can failures be injected
  deterministically?
- [Affects R11-R13, R19-R20][Needs research] Which content-free operational
  metric, health, log, and receipt dimensions are sufficient for diagnosis
  without creating another telemetry authority or leaking local paths?
- [Affects R1, R3, R10-R15, R19][Needs research] What command semantics,
  confirmation boundaries, exit statuses, dry-run behavior, and
  machine-readable output make local doctor/backup/restore/rebuild/purge-audit
  safe and scriptable?
- [Affects R19-R20][Needs research] What evidence-bundle, artifact-integrity,
  runbook-exercise, supply-chain, and review rules are required for an honest
  exact-platform G6 `GO`?

### Deferred to Planning

- [Affects R1-R20][Technical] How to split M6 into independently reversible
  commits so backup/key/frontier changes do not land ahead of their recovery
  and failure Oracles.
- [Affects R2-R3, R15, R18][Technical] Which package owns the key-provider
  abstraction and ciphertext envelope while keeping cryptography out of MCP
  and preserving the single SQLite writer.
- [Affects R4-R15, R19][Technical] Which existing storage health/backup/
  restore APIs are extended versus wrapped by the operator surface.
- [Affects R20][Technical] How the G6 verifier distinguishes frozen logical
  evidence from environment-specific timing observations and optional-lane
  `NO-GO` state.
