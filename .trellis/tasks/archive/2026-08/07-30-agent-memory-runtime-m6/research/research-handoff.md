# Memo Graph M6 Operational Hardening Research Handoff

## Research result

M6 should harden the accepted local runtime as one exact-platform operational
baseline:

```text
content-free doctor
  → bounded write admission
  → encrypted canonical secret storage
  → complete frontier-aware backup
  → empty-root staging restore
  → deterministic repair and purge audit
  → frozen fault/resource/security/runbook evidence
  → first-false G6 decision
```

SQLite remains the sole authority. Graph and vector remain `NO-GO`, automatic
learning publication remains disabled, and `NO-GO` is a complete G6 outcome.

## Required implementation consequences

### Encryption and key lifecycle

- Keep `ENCRYPTION_REQUIRED` until a secret payload is encrypted before its
  first durable write.
- Use a versioned AEAD envelope that binds `key_id`, nonce, authentication tag,
  algorithm/version, canonical identity, scope, sensitivity, and content
  identity through authenticated metadata.
- Generate a fresh unique nonce for every encryption under a key and verify
  the tag before exposing plaintext.
- Support a bounded state machine: `current`, `retired`,
  `revoked_or_compromised`, and `unavailable`.
- Only `current` encrypts. `retired` can decrypt already-bound ciphertext for
  authorized reads or rotation. Unknown, ambiguous, wrong, revoked, or missing
  key state blocks secret serving without plaintext fallback.
- Make rotation crash-safe and resumable. Keep the old key usable until every
  rewritten artifact and the new key-state receipt commit.
- Do not place raw keys in SQLite, backup manifests, diagnostics, logs, or
  release evidence. Backups bind key identities and format versions.
- Preserve the existing rejection of shared, removable, network, and
  cloud-synchronized roots. Application encryption does not widen the
  supported filesystem boundary.

### Complete backup and restore

- Extend the manifest beyond the SQLite file to bind every blob/ciphertext
  hash and size, schema/migration set, ledger/tombstone/purge frontier, latest
  receipt, projection frontier, learning control/release frontier, active key
  identities and encryption format, configuration, and environment.
- Keep SQLite's online backup API as the database snapshot primitive.
- Restore only to a new empty data root. Validate the manifest, artifacts,
  required keys, and externally supplied minimum frontiers before publication.
- Copy into staging, set restrictive permissions, fsync files/directories,
  open and run the full restore Oracle, mark rebuildable projections
  degraded/unavailable, close, then atomically rename.
- On any error, remove staging and leave the target absent.
- Never activate graph, vector, or candidate-only learning state during
  restore.

### Capacity, WAL, and backpressure

- Extend health with available bytes, database/WAL/backup sizes, checkpoint
  counters, writer queue depth/oldest age/completions, active maintenance
  operation, and key readiness.
- Compile those signals into stable `ready`, `degraded`, `read_only`, and
  `blocked` states plus typed reason codes.
- Bound the writer queue. Reject before a transaction starts when queue
  depth/age, disk safety headroom, or an incompatible maintenance operation
  exceeds the frozen policy.
- Calibrate Small/Expected thresholds from measured resource evidence and
  maximum-operation headroom. Do not claim universal SLOs from local numbers.
- Treat checkpoint `busy`, `log`, and `checkpointed` as separate observations.
  Test long-reader WAL growth, repeated busy results, disk-full behavior, and
  recovery convergence.

### Content-free operator surface

- Use one typed schema for health, metrics, logs, CLI JSON, human rendering,
  and operational receipts.
- Permit time, component, operation, state, reason code, duration, capacity,
  queue values, counters, and hash/frontier identities.
- Forbid memory, Context, tool/request bodies, search queries, plaintext,
  ciphertext bytes, raw keys, tokens, and raw paths.
- Provide a thin local CLI for `doctor`, `backup`, `restore`, `rebuild`,
  `purge-audit`, key inspection/rotation, and G6 verification.
- Keep `doctor` read-only. Require dry-run and explicit confirmation for
  restore, purge retry, key mutation, and other destructive/offline actions.
- Give human and JSON modes identical semantics and stable exit classes for
  healthy, degraded, operator action required, invalid input, and internal
  failure.
- Reuse OpenTelemetry's typed-field model as guidance; do not add a Collector
  or SDK dependency merely to satisfy M6.

### Fault and recovery Oracles

- Add deterministic hooks around migration, canonical commit/receipt,
  encrypted blob temp/write/rename, key rotation, backup copy/manifest,
  restore staging/publish, checkpoint, every purge store, and learning pointer
  rollback.
- For each crash point prove old-or-new canonical state, receipt/epoch/frontier
  agreement, restart idempotency, and no deleted, secret, or candidate
  resurrection.
- Derived corruption may only produce a named degraded state and a canonical
  rebuild path. It cannot become `NO_MATCH`.
- SQLite recovery is quarantined salvage only. It may resurrect deleted data
  or violate constraints, so it cannot auto-publish or satisfy G6.

### G6 evidence and decision

- Bind exact commit/tree, pnpm lock and approved native build set,
  Node/pnpm/SQLite/OS/architecture/filesystem, schema, configuration,
  thresholds, fixtures, prior G3R/G4A/G4B/G5 decisions, and all fault,
  security, resource, backup/restore, purge, encryption, learning-rollback,
  and runbook reports.
- Record raw and canonical hashes for every report.
- Run frozen-lock checks, `pnpm audit --json` under an explicit severity
  policy, and approved native-build verification. Registry failure is blocked,
  not a successful ignored audit.
- Evaluate hard rules conjunctively. The first false integrity, privacy,
  deletion, encryption, restore, rollback, supply-chain, or evidence-binding
  rule forces `NO-GO`.
- Scope any `GO` to the exact tested local single-user topology. It is not a
  remote-sync, multi-user, HA, general secret-manager, fleet, or production-SLO
  claim.

## Recommended work-unit sequence

1. Contracts, typed diagnostics, readiness, and CLI skeleton.
2. AEAD envelope, key provider, key-state ledger, secret admission, and
   rotation.
3. Complete backup manifest, key/frontier verification, staging restore, and
   publication.
4. Capacity/WAL/queue admission control and checkpoint convergence.
5. Repair orchestration, purge audit, content-free observability, and
   executable runbooks.
6. Deterministic fault, security, resource, backup/restore, encryption,
   deletion, and learning-rollback evidence.
7. Immutable G6 manifest/verifier, independent review, and one GO/NO-GO
   decision.

Each unit is independently testable and should be committed separately.

## Gate result

- Research Ready Gate: **PASS**
- Questions: 7/7 answered
- Claims: 21/21 supported
- Core Claims: 16/16 supported
- Open/conflicted Claims: 0
- Web evidence: 13 primary-source packages in 6 independence groups
- Code evidence: 17 packages at
  `be839ff9e174a65a9314e5dbff4d32d7828186f3`
- Article/HTML: not generated

Source topic:
`/Users/lienli/Documents/work/深度调研/research/memo-graph-m6-operational-hardening`
