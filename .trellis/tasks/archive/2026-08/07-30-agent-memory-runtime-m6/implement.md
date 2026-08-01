# Agent Memory Runtime M6 — Execution Checklist

## 1. Execution contract

This checklist executes
`docs/plans/2026-07-30-001-feat-agent-memory-runtime-m6-operational-hardening-plan.md`.

Rules:

- Keep the Trellis task in `planning` until this file, `design.md`, both
  context manifests, document review, and `task.py validate` pass.
- After activation, execute U1 → U4 → U2 → U3 → U5 → U9 → U6 → U7 → U8.
  Stable U-IDs remain intentionally non-numeric after plan deepening.
- Load `trellis-before-dev` before editing each unit and `trellis-check` after
  its focused implementation.
- Run Node commands only after:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
```

- Start every logical task from a clean worktree.
- Write failing tests/fixtures before behavior whenever the unit adds runtime
  behavior.
- Stop on a focused verification failure. Do not suppress, weaken, skip, or
  relabel a hard gate.
- Complete exactly one logical task, verify it, and create exactly one commit.
  Do not batch U-IDs or amend a prior task commit.
- Preserve unrelated user changes if they appear.
- Do not push, open a PR, or publish externally without explicit user
  authorization.
- U7 evidence runs from a clean committed U6 candidate.
- U8 decision reads verifier-backed evidence only.
- Archive, journal, and parent-roadmap closure remain separate tasks/commits
  after U8. Parent status, archive, and journal are also separate when they
  touch independent artifact classes.

Planned commit map:

| Task | Commit subject |
| --- | --- |
| ce-plan | `docs(m6): plan operational hardening` |
| task activation | `chore(trellis): start M6 operational hardening` |
| U1 | `feat(operations): add typed readiness and operator shell` |
| U2 | `feat(storage): encrypt secret content and govern keys` |
| U3 | `feat(recovery): publish complete verified restores` |
| U4 | `feat(storage): bound pressure and maintenance admission` |
| U5 | `feat(operations): add repair audit and runbooks` |
| U9 | `feat(storage): qualify governed secret admission` |
| U6 | `test(g6): freeze operational release harness` |
| U6R if needed | `fix(operations): harden G6 candidate` |
| U7 | `docs(g6): bind operational release evidence` |
| U8 | `docs(g6): record operational release decision` |
| M6 archive | `chore(trellis): archive M6 operational hardening` |
| M6 journal | `docs(trellis): record M6 operational hardening session` |
| parent status | `docs(roadmap): close agent memory runtime roadmap` |
| parent archive | `chore(trellis): archive agent memory runtime roadmap` |
| parent journal | `docs(trellis): record agent memory runtime closure` |

If implementation proves a unit is not atomic, update the durable plan first,
assign the next unused stable U-ID, and do not renumber existing units.

### Execution ledger

M6 reached its terminal U8 boundary on 2026-08-02. Unit completion is recorded
by immutable commits rather than by retroactively rewriting every design-time
checkbox:

| Unit | Commit / outcome |
| --- | --- |
| U1 | `b0cd16b` typed readiness and operator shell |
| U4 | `576ecc2` bounded pressure and maintenance admission |
| U2 | `66cdfc5` encrypted secret persistence and governed keys |
| U3 | `e386274` complete verified restore publication |
| U5 | `0150dd1` repair audit and executable Runbooks |
| U9 | `e0a8872` governed secret-admission qualification |
| U6 | `707f70b` frozen harness plus R1-R5 remediation commits |
| U7 | `33549e6` immutable G6 evidence |
| U8 | G6 `NO-GO`; first non-pass `integrity`, signed control non-enabling |

U7 honestly preserves two terminal blocked boundaries: 40 fault obligations
lack direct per-obligation proof, and ten Runbook paths lack direct typed
automation observation. Those unchecked success conditions are not waived;
they force the supported G6 `NO-GO`.

## 2. Non-negotiable invariants

- [ ] SQLite remains the sole authority for canonical, key state,
      maintenance, purge, learning, idempotency, and receipts.
- [ ] Raw key bytes never enter SQLite, backup manifest, receipt, log,
      diagnostic, evidence, or git-tracked fixture/report.
- [ ] Secret plaintext is encrypted before SQLite/WAL/blob-temp/backup
      durability.
- [ ] The private main-thread `SecretIngressCoordinator` is the sole storage
      plaintext-ingestion boundary.
- [ ] Secret plaintext never crosses worker structured-clone IPC, an outward
      storage result, CLI/MCP renderer, log, error, diagnostic, receipt, or
      evidence boundary.
- [ ] Public operational output contains no stable plaintext-derived
      content/path hash.
- [ ] Secret content remains excluded from standard MCP recall and model
      Context.
- [ ] Restore publishes only to a previously absent target using verified
      staging and one audited no-replace atomic publication.
- [ ] Snapshot freshness requires a hash-bound external recovery anchor.
- [ ] Graph remains G4A `NO-GO`; vector remains G4B `NO-GO`; neither is
      started, imported, or required.
- [ ] Automatic learning publication remains disabled; candidate-only state
      cannot activate during restore or repair.
- [ ] A rejected/blocked write creates no effect, idempotency row, receipt, or
      frontier movement and cannot execute later.
- [ ] One fenced root-writer lease prevents MCP/runtime and effect-bearing CLI
      processes from owning the same root concurrently.
- [ ] No operational error is mapped to `NO_MATCH`.
- [ ] Human CLI, JSON CLI, MCP health, logs, and operational receipts share
      one semantic schema.
- [ ] Runtime readiness and G6 qualification are independent; only an exact
      U8 `GO` release control may permit secret admission.
- [ ] Dry-run and execution are bound by the same operation digest and current
      frontier.
- [ ] Purge cannot complete without an explicit verified outcome for every
      registered artifact class.
- [ ] Logs/metrics are observations; receipts are the replayable audit
      authority.
- [ ] SQLite salvage is quarantined and never auto-published or counted as G6
      recovery.
- [ ] G6 is conjunctive and first-false; no aggregate result compensates for
      integrity/privacy/deletion/encryption/restore/rollback/supply-chain
      failure.

## 3. U1 — Operational contracts, readiness, and operator shell

**Requirements:** R1-R3, R5, R10-R13, R18-R20; startup/diagnosis; M6 AE5.

**Depends on:** None.

**Files:**

- `packages/contracts/src/operations.ts`
- `packages/contracts/src/mcp.ts`
- `packages/contracts/src/index.ts`
- `apps/operator-cli/{package.json,tsconfig.json}`
- `apps/operator-cli/src/{cli,config,exit-codes,render}.ts`
- `apps/operator-cli/src/commands/doctor.ts`
- `packages/storage-sqlite/src/operational-health.ts`
- `packages/storage-sqlite/src/{protocol,client,errors}.ts`
- `packages/mcp-server/src/{index,cli}.ts`
- `package.json`
- `tsconfig.json`
- `tests/contract/operations.contract.test.ts`
- `tests/integration/operator-cli.integration.test.ts`
- `tests/integration/operator-health-parity.integration.test.ts`
- `tests/recovery/canonical-corruption-startup.recovery.test.ts`
- `tests/security/operational-redaction.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Re-read PRD diagnosis, actor authority, M6 AE5, content-free fields, and
      blocked-startup requirements.
- [ ] Search all `StorageHealthSchema`, `StorageClientHealth`,
      `StorageDiagnostic`, MCP health, startup error, and error mapping
      consumers.
- [ ] Characterize current healthy open, optional-lane degradation,
      migration drift, corruption, and MCP startup behavior.
- [ ] Confirm operator CLI is a new `apps/*` workspace and does not add a
      second storage owner.

### Test-first checklist

- [ ] Accept one complete content-free readiness object for each top-level
      state.
- [ ] Reject unknown state/reason/action/component/measurement/exit values.
- [ ] Reject duplicate reason codes, invalid ordering, mismatched primary
      reason, non-finite measurements, and invalid hashes/frontiers.
- [ ] Prove readiness reduction is deterministic under reordered raw
      observations.
- [ ] Prove readiness and qualification vary independently across pending,
      GO, NO-GO, outside-tested-envelope, degraded, and blocked fixtures.
- [ ] Prove JSON and human renderers describe the same parsed object and exit
      class.
- [ ] Reject stable plaintext-derived content/path hashes on public
      operational surfaces; test low-entropy dictionary and cross-bundle
      linkability.
- [ ] Prove healthy MCP health and CLI doctor semantic equality.
- [ ] Prove migration drift, wrong-key placeholder, corruption, and unsafe
      root can expose blocked health without exposing memory tools.
- [ ] Prove true no-match, optional outage, read-only pressure, corruption,
      and internal failure remain distinct.
- [ ] Scan output/errors/stderr for memory, Context, query, ciphertext, key,
      token, raw path, and configured marker strings.
- [ ] Prove invalid config fails before a storage effect and is redacted.
- [ ] Reject generic, stale, cross-command/target, expired, replayed, or
      payload-self-authorized operation confirmation with zero effects.

### Implementation checklist

- [ ] Add strict operational schemas and inferred public types.
- [ ] Add one pure readiness reducer with stable reason severity/order.
- [ ] Add independent G6 qualification and tested-envelope digest fields.
- [ ] Add stable semantic exit classes and one numeric mapping owner.
- [ ] Add operator config parsing from `unknown` with no secret echo.
- [ ] Add full-intent operation digest, single-use nonce/expiry, independent
      confirmation, and atomic-consumption contracts.
- [ ] Add root lease owner/fence/heartbeat/stale-recovery contracts for U4.
- [ ] Add JSON/human rendering from the same result.
- [ ] Add read-only doctor command.
- [ ] Extend storage health through an operational adapter.
- [ ] Add blocked-runtime MCP preflight shell.
- [ ] Reject ordinary memory tools while blocked.
- [ ] Keep graph/vector disabled and present as accepted configuration.
- [ ] Add root build/typecheck coverage for the operator app.
- [ ] Export no raw internal path or storage-driver type.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/contract/operations.contract.test.ts \
  tests/integration/operator-cli.integration.test.ts \
  tests/integration/operator-health-parity.integration.test.ts \
  tests/recovery/canonical-corruption-startup.recovery.test.ts \
  tests/security/operational-redaction.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] One semantic readiness-plus-qualification object feeds CLI JSON/human
      and MCP without conflating the two states.
- [ ] Blocked startup remains diagnosable but cannot serve memory.
- [ ] U1 contains no migration or effect-bearing operator command.
- [ ] `trellis-check` has no unresolved finding.
- [ ] Create only the U1 commit.

**Rollback point:** remove the operator shell/contracts and restore generic MCP
startup failure; no durable state changes exist.

## 4. U2 — Dark-launch AEAD, key lifecycle, and rotation

**Requirements:** R2-R3, R6-R7, R14-R15, R18-R20; secret lifecycle; M6 AE8.

**Depends on:** U1 and U4.

**Files:**

- `packages/contracts/src/encryption.ts`
- `packages/contracts/src/{operations,memory,mcp,tool-inputs,receipts,g6,index}.ts`
- `migrations/0015-operational-hardening.sql`
- `packages/storage-sqlite/src/key-repository.ts`
- `packages/storage-sqlite/src/encrypted-content-store.ts`
- `packages/storage-sqlite/src/secret-ingress.ts`
- `packages/storage-sqlite/src/operational-repository.ts`
- `packages/storage-sqlite/src/{blob-store,database,storage-worker,client}.ts`
- `packages/storage-sqlite/src/{governance-repository,governed-memory-reader}.ts`
- `packages/storage-sqlite/src/{purge-repository,protocol,index}.ts`
- `packages/memory-kernel/src/{approval,index}.ts`
- `packages/mcp-server/src/{index,cli}.ts`
- `apps/operator-cli/src/cli.ts`
- `apps/operator-cli/src/commands/{key,secret}.ts`
- `tests/contract/encryption.contract.test.ts`
- `tests/contract/g6.contract.test.ts`
- `tests/storage/operational-schema.integration.test.ts`
- `tests/storage/encryption-key-lifecycle.integration.test.ts`
- `tests/recovery/key-rotation.recovery.test.ts`
- `tests/security/secret-at-rest.test.ts`
- `tests/security/secret-content-residual.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Re-read encryption/key design and `ENCRYPTION_REQUIRED` rollback rule.
- [ ] Characterize all secret rejection/exclusion sites in storage,
      governance, memory-kernel, MCP, FTS, projections, and Context Compiler.
- [ ] Characterize current migrations and every payload table CHECK.
- [ ] Confirm no accepted database can contain secret plaintext.
- [ ] Freeze the exact 0015 table-copy/index/trigger/FK impact and verify a
      pre-upgrade backup.
- [ ] Confirm provider accepts fixed-size key bytes only from an opened,
      private, owner-checked local regular file; never argv/env/inline config.

### Test-first checklist

- [ ] Accept one complete versioned envelope and each legal key state.
- [ ] Pass AES-256-GCM v1 known-answer vectors with 32-byte key, 12-byte
      nonce, 16-byte tag, and domain-separated canonical AAD bytes.
- [ ] Reject wrong AAD identity/scope/sensitivity/content identity.
- [ ] Reject unknown version/algorithm/key, malformed nonce/tag/ciphertext,
      ambiguous current key, and mismatched ciphertext hash/size.
- [ ] Reject nonce reuse/collision across concurrency, retry, restart, and
      rotation; only the same prepared idempotent operation may reuse its
      reserved nonce.
- [ ] Same idempotency key with changed key generation, AAD hash, keyed
      commitment, owner generation, or request digest fails without nonce
      reuse.
- [ ] Reject truncated tag, wrong parameter lengths, unknown suite/version,
      and AAD field-order/domain changes before decrypt.
- [ ] Prove existing non-secret database upgrade preserves rows, hashes,
      counts, receipts, and frontiers.
- [ ] Inject migration interruption at create/copy/validate/swap/commit and
      prove fail-before-serving plus forward recovery.
- [ ] Prove normal secret admission remains `ENCRYPTION_REQUIRED`.
- [ ] Prove the dark-launch test path persists ciphertext only.
- [ ] Prove operator `secret admit --input-fd <n>` is the sole plaintext
      ingress and every MCP tool rejects secret plaintext.
- [ ] Accept only a complete `SecretAdmissionApproval`; reject missing, stale,
      reused, wrong principal/owner/scope/request/envelope/key/fence/expiry
      grants with no enqueue, durable effect, or consumption.
- [ ] Reject forged/replayed/expired/wrong-purpose/cross-owner/cross-scope
      `SecretUseAuthority`.
- [ ] Scan database, WAL, FTS, projection/outbox, blob/temp, backups,
      diagnostics, logs, and receipts for plaintext/key markers.
- [ ] Prove wrong/missing/revoked/unavailable key fails closed while verified
      ordinary non-secret reads continue where safe.
- [ ] Prove standard MCP recall and Context still exclude secret content.
- [ ] Prove plaintext/key never crosses worker structured-clone or outward
      storage result, CLI/MCP response, error, log, diagnostic, receipt, or
      evidence; zero buffers best-effort.
- [ ] Inject faults around encrypted temp/write/fsync/rename/reference commit.
- [ ] Inject faults around rotation begin/item/final-state/receipt.
- [ ] Inject process termination around prepared/file/committed/retired
      transitions and reconcile orphan/temp/ciphertext state on startup.
- [ ] Prove rotation resume is idempotent and never strands an item between
      keys.
- [ ] Prove purge removes all supported live secret references and leaves no
      supported decryptable result.

### Implementation checklist

- [ ] Add envelope/AAD/key/rotation, `SecretUseAuthority`, and
      `SecretAdmissionApproval` schemas and canonical seal checks.
- [ ] Add authoritative `G6ReleaseControl`/signature and injectable
      `RuntimeIdentityProvider` contracts using synthetic identities only.
- [ ] Add keyed owner/scope commitment; never persist an unkeyed
      plaintext-derived secret hash.
- [ ] Add forward-only migration without editing prior migrations, including
      inline encrypted content, bounded external-blob operation state, store
      registry, purge frontiers/debt, and `(key_id, nonce)` uniqueness.
- [ ] Make inline SQLite ciphertext the default atomic path; use external
      encrypted artifacts only for payloads already above the blob threshold.
- [ ] Add the non-exported main-thread `SecretIngressCoordinator`; reserve
      nonce in the worker, encrypt before IPC, zero plaintext best-effort, and
      send only ciphertext/envelope metadata to the worker.
- [ ] Add prepared/committed/retired artifact protocol, idempotent operation
      ID, startup reconciliation, and orphan quarantine only for the bounded
      external encrypted-blob path.
- [ ] Add key state and rotation repositories under the storage worker.
- [ ] Pass key material in memory only and redact all provider errors.
- [ ] Allow only `current` to encrypt and purpose-authorized retired-key
      decrypt; key availability alone is never authority.
- [ ] Add the secret-admission approval registry and transactional
      consumption protocol in dark-launch mode.
- [ ] Route only the operator private inherited descriptor to secret ingress;
      MCP secret requests can reference already-encrypted evidence but cannot
      resend plaintext.
- [ ] Register key/secret commands explicitly in `apps/operator-cli/src/cli.ts`.
- [ ] Expose key inspection only; operator rotation and secret admission remain
      disabled until U5 and U8 respectively. Internal tests may call the
      capability directly.
- [ ] Add explicit rotation generation: old key stays sole current, new key is
      `rotating_to`, secret writes quiesce, completion atomically swaps state
      plus receipt, and abort is legal only before the first rewrite.
- [ ] Keep normal secret admission rejected until an exact U8 G6 release
      control exists.
- [ ] Keep default model/MCP eligibility excluded.
- [ ] Integrate secret purge outcomes.
- [ ] Add key inspect/rotation dry-run shape but no generic bypass.
- [ ] Update storage error mapping exhaustively.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/contract/encryption.contract.test.ts \
  tests/contract/g6.contract.test.ts \
  tests/storage/operational-schema.integration.test.ts \
  tests/storage/encryption-key-lifecycle.integration.test.ts \
  tests/recovery/key-rotation.recovery.test.ts \
  tests/security/secret-at-rest.test.ts \
  tests/security/secret-content-residual.test.ts
pnpm test:storage
pnpm test:recovery
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Secret plaintext/key markers are absent from every scanned artifact.
- [ ] Rotation and migration fault matrices prove old-or-new and resume.
- [ ] Startup reconciliation proves every prepared/orphan state converges.
- [ ] Normal runtime still rejects secret admission until an exact U8 G6
      release control exists.
- [ ] Default Context exclusion is unchanged.
- [ ] `trellis-check` has no unresolved finding.
- [ ] Create only the U2 commit.

**Rollback point:** once 0015 applies, do not revert code/migration in place.
Use an 0015-aware roll-forward binary or publish a new root from the verified
pre-migration backup. Secret admission remains `ENCRYPTION_REQUIRED`; no
plaintext fallback exists.

## 5. U3 — Complete backup manifest and external-anchor restore

**Requirements:** R2-R9, R14-R20; backup/restore; M6 AE1-AE4 and
M6 AE6-AE8.

**Depends on:** U2 and U4.

**Files:**

- `packages/contracts/src/operations.ts`
- `packages/storage-sqlite/src/backup-manifest.ts`
- `packages/storage-sqlite/src/anchor-coordinator.ts`
- `packages/storage-sqlite/src/{database,client,protocol,storage-worker,restore,data-root,no-replace-publish,index}.ts`
- `packages/storage-sqlite/src/{control-repository,governance-repository,purge-repository}.ts`
- `packages/storage-sqlite/src/{learning-repository,projection-repository,projection-effects,key-repository}.ts`
- `packages/storage-sqlite/package.json`
- `tools/rename-noreplace/{rename-noreplace.c,build.mjs}`
- `apps/operator-cli/src/cli.ts`
- `apps/operator-cli/src/config.ts`
- `apps/operator-cli/src/commands/{backup,restore}.ts`
- `packages/mcp-server/src/cli.ts`
- `tests/storage/fts-and-backup.integration.test.ts`
- `tests/recovery/complete-backup-restore.recovery.test.ts`
- `tests/recovery/encrypted-backup-restore.recovery.test.ts`
- `tests/recovery/stale-tombstone-restore.recovery.test.ts`
- `tests/recovery/learning-ledger.recovery.test.ts`
- `tests/recovery/restored-learning-rollback.recovery.test.ts`
- `tests/recovery/paused-learning-snapshot.recovery.test.ts`
- `tests/recovery/disabled-optional-lanes-restore.recovery.test.ts`
- `tests/integration/m6-restored-context-equivalence.integration.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Re-read complete manifest, recovery anchor, purge-debt, and
      publish-new-root rules.
- [ ] Characterize current online backup, blob copy, integrity, learning
      frontier, restore staging, fsync, cleanup, and publication tests.
- [ ] Enumerate every authority/artifact frontier from current schema and
      accepted G3R/G4A/G4B/G5 artifacts.
- [ ] Freeze recovery-anchor issuer, root/principal binding, external
      location, provider-held authentication key, monotonic CAS/hash chain,
      pending/committed/reconciled state machine, trust-root rotation, and
      loss-as-blocked rules.
- [ ] Enumerate governed canonical/correction, control/revoke/delete/
      tombstone/purge, Context/projection, learning control/release/rollback,
      key lifecycle/rotation completion, and installed G6 control as protected
      operations with named repository owners.
- [ ] Freeze separately retained `RecoveryHeadProvider` location, current-head
      read/atomic-replace/fsync semantics, and local-administrator compromise
      exclusion.
- [ ] Confirm recovery anchor is supplied outside the snapshot and cannot be
      created/reset by it.

### Test-first checklist

- [ ] Reject manifest missing database/blob/ciphertext/migration/schema/
      config/environment/frontier/key/prior-decision binding.
- [ ] Reject duplicate/extra/unbound artifact descriptors.
- [ ] Reject raw key/path/content fields in the public manifest.
- [ ] Prove raw and canonical hashes detect byte and logical tampering.
- [ ] Reject absent, forged, malformed, stale, or incompatible recovery
      anchor.
- [ ] Reject snapshot+anchor joint replacement while the separately retained
      current head remains intact, old valid anchor rollback, unauthorized
      signer, missing trust root, and trust-root rotation mismatch.
- [ ] Reject snapshot behind tombstone, purge, receipt, projection, Context,
      learning control/release, or required key minima.
- [ ] Inject termination before pending-anchor fsync, after pending fsync,
      after SQLite effect commit, before committed-head fsync, and before
      anchored-receipt reconciliation.
- [ ] Prove startup reconciles committed effects, while every unresolved
      pending reservation remains a fail-closed restore minimum.
- [ ] Prove only a definitely absent idempotent SQLite effect may advance a
      pending reservation to signed `aborted`; ambiguity remains blocked.
- [ ] Prove every protected repository transaction requires an
      `AnchorCoordinator` pending ID; provider loss/request override/bypass
      cannot commit.
- [ ] Reject existing/non-absolute/root/symlink target.
- [ ] Race target create/open/symlink at reservation, verification,
      no-replace publish, and parent-fsync boundaries without overwrite.
- [ ] Inject fault at database copy, artifact copy, manifest verification,
      key verification, migration, purge audit, derived degradation, fsync,
      close, publication-marker write, rename, parent fsync, and response.
- [ ] Prove pre-rename failure leaves source intact/staging removed/target
      absent; post-rename interruption leaves a complete reopenable target.
- [ ] Prove M6 AE1 restored preference/project constraint equivalence and
      budget.
- [ ] Prove M6 AE3 graph/vector-disabled restore starts no optional dependency.
- [ ] Prove M6 AE4 deleted marker cannot return through old backup.
- [ ] Prove M6 AE6 restored monitor breach exact rollback.
- [ ] Prove M6 AE7 paused snapshot continuity.
- [ ] Prove M6 AE8 encrypted snapshot wrong-key and purge behavior.

### Implementation checklist

- [ ] Extend online backup rather than file-copying live SQLite.
- [ ] Acquire the fenced maintenance/root lease and freeze epoch, receipt, and
      versioned artifact inventory for the whole backup/manifest fsync cut.
- [ ] Build canonical complete manifest and raw/canonical bindings.
- [ ] Add authenticated external anchor chain/CAS/trust-root parser and the
      durable `pending → SQLite effect → committed → reconciled` protocol plus
      signed `aborted` only for a provably absent effect.
- [ ] Add mandatory storage `AnchorCoordinator` integration to every
      enumerated repository and inject its provider only from trusted
      MCP/operator composition config.
- [ ] Add separately retained current-head provider; snapshot/anchor bundle
      cannot assert its own freshness.
- [ ] Copy and fsync all blob/ciphertext artifacts.
- [ ] Verify key identities without storing raw keys.
- [ ] Verify every canonical/frontier/receipt/purge/learning invariant through
      U2's versioned store registry.
- [ ] Block any unverified canonical/ciphertext/backup/key/purge debt; only
      rebuildable derived projection absence may degrade.
- [ ] Mark rebuildable derived state degraded/unavailable.
- [ ] Prevent graph/vector/candidate-only activation.
- [ ] Acquire fenced parent target-name reservation and publish through the
      audited Darwin `renameatx_np(RENAME_EXCL)` helper; unsupported capability
      blocks. Fsync parent and reconcile response loss idempotently.
- [ ] Register backup/restore commands explicitly in
      `apps/operator-cli/src/cli.ts`.
- [ ] Expose backup/restore verification, but keep operator restore
      publication disabled until U5 signs and journals the cross-resource
      effect; recovery tests call the internal capability.
- [ ] Redact public backup/restore outputs and bind dry-run digest.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/storage/fts-and-backup.integration.test.ts \
  tests/recovery/complete-backup-restore.recovery.test.ts \
  tests/recovery/encrypted-backup-restore.recovery.test.ts \
  tests/recovery/stale-tombstone-restore.recovery.test.ts \
  tests/recovery/restored-learning-rollback.recovery.test.ts \
  tests/recovery/paused-learning-snapshot.recovery.test.ts \
  tests/recovery/disabled-optional-lanes-restore.recovery.test.ts \
  tests/integration/m6-restored-context-equivalence.integration.test.ts
pnpm test:storage
pnpm test:recovery
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Complete/current snapshot publishes one equivalent new root.
- [ ] Every stale/tampered/wrong-key/partial input leaves target absent.
- [ ] M6 AE1-AE4 and M6 AE6-AE8 recovery assertions pass.
- [ ] `trellis-check` has no unresolved finding.
- [ ] Create only the U3 commit.

**Rollback point:** use the prior limited API only on an independently
preserved pre-0015 root. After migration, roll forward or publish a new root
from the verified pre-migration backup. Secret admission remains blocked.

## 6. U4 — Capacity, WAL, queue, and maintenance admission

**Requirements:** R3, R5, R10-R13, R19-R20; fault recovery; M6 AE5.

**Depends on:** U1. Execute U4 before U2 and U3.

**Files:**

- `packages/storage-sqlite/src/admission-control.ts`
- `packages/storage-sqlite/src/root-lease.ts`
- `packages/storage-sqlite/src/operational-health.ts`
- `packages/storage-sqlite/src/{writer-queue,client,database,storage-worker}.ts`
- `packages/storage-sqlite/src/{errors,protocol}.ts`
- `packages/memory-kernel/src/index.ts`
- `packages/mcp-server/src/index.ts`
- `fixtures/g6/thresholds.json`
- `tests/storage/admission-control.test.ts`
- `tests/recovery/storage-pressure.recovery.test.ts`
- `tests/recovery/wal-checkpoint.recovery.test.ts`
- `tests/recovery/maintenance-concurrency.recovery.test.ts`
- `tests/recovery/root-lease.recovery.test.ts`
- `tests/integration/bounded-write-admission.integration.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Characterize queue metrics, busy timeout, WAL/journal limits,
      autocheckpoint, explicit checkpoint, and storage error mappings.
- [ ] Characterize current same-root behavior across two clients/processes.
- [ ] Enumerate every writer-queue operation and maintenance operation.
- [ ] Define Small/Expected measurement procedure and maximum-operation
      headroom.
- [ ] Confirm thresholds are exact-platform fixtures, not production SLOs.

### Test-first checklist

- [ ] Reject queue depth saturation before enqueue.
- [ ] Reject oldest-age saturation and prove rejected work never executes.
- [ ] Recheck accepted queued work before transaction after readiness changes.
- [ ] Prove zero idempotency/receipt/frontier drift on both rejection points.
- [ ] Inject low disk before existing canonical/WAL/checkpoint boundaries.
      U2 owns ciphertext boundaries and U3 owns complete-backup boundaries.
- [ ] Prove verified reads continue in declared read-only state.
- [ ] Prove hysteresis prevents immediate writable/read-only flapping.
- [ ] Hold a long reader, grow WAL, record busy/log/checkpointed separately,
      and prove bounded post-reader convergence.
- [ ] Test existing allowed/rejected maintenance pairs and prove unknown
      future operations reject. U2/U3 add their concrete rows; U5 closes the
      cross-operation matrix.
- [ ] Prove two writer processes cannot acquire the same root; effect CLI
      rejects a live runtime before opening storage.
- [ ] Prove stale-owner recovery requires exact root/fence/heartbeat/owner-not-
      live evidence and cannot steal a live or ambiguous lease.
- [ ] Prove doctor remains available during maintenance.
- [ ] Prove pressure/maintenance errors remain distinct through
      memory-kernel/MCP.
- [ ] Measure Small/Expected profiles reproducibly before freezing values.

### Implementation checklist

- [ ] Add capacity/WAL/queue/maintenance observations available before U2/U3.
- [ ] Add root lease owner/fence/heartbeat state and content-free health.
- [ ] Acquire runtime writer lease before normal open.
- [ ] Require effect CLI runtime-stop and exclusive lease.
- [ ] Add confirmed stale-owner recovery with monotonic fence advance.
- [ ] Add frozen admission policy and hysteresis schema.
- [ ] Bound queue entries and age.
- [ ] Add pre-enqueue and transaction-start checks.
- [ ] Add explicit rejection metrics and typed errors.
- [ ] Add fail-closed maintenance compatibility reducer for existing
      operations; leave explicit U2/U3 extension points in the same owner.
- [ ] Preserve independent checkpoint counters and bounded retry.
- [ ] Propagate stable states/actions through all public surfaces.
- [ ] Freeze measured thresholds with environment/workload identity.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/storage/admission-control.test.ts \
  tests/recovery/storage-pressure.recovery.test.ts \
  tests/recovery/wal-checkpoint.recovery.test.ts \
  tests/recovery/maintenance-concurrency.recovery.test.ts \
  tests/recovery/root-lease.recovery.test.ts \
  tests/integration/bounded-write-admission.integration.test.ts
pnpm test:storage
pnpm test:recovery
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Queue and disk pressure are bounded before unsafe effects.
- [ ] Same-root writer exclusion and stale recovery Oracles pass.
- [ ] WAL/checkpoint recovery converges with separate counters.
- [ ] Frozen values carry exact workload/environment identity.
- [ ] `trellis-check` has no unresolved finding.
- [ ] Create only the U4 commit.

**Rollback point:** disable new writes and retain verified read-only behavior;
do not restore unbounded writes as a release candidate.

## 7. U5 — Repair, purge audit, observability, and runbooks

**Requirements:** R1, R3, R6-R8, R11-R15, R17-R20; repair/purge; M6 AE2-AE7.

**Depends on:** U2-U4.

**Files:**

- `packages/contracts/src/operations.ts`
- `packages/storage-sqlite/src/operational-repository.ts`
- `packages/storage-sqlite/src/{purge-repository,projection-repository,learning-repository,client}.ts`
- `apps/operator-cli/src/{cli,confirmation-authority,operator-action-ledger}.ts`
- `apps/operator-cli/src/commands/{rebuild,purge-audit,key,restore,rollback,g6}.ts`
- `docs/runbooks/m6-doctor.md`
- `docs/runbooks/m6-backup-restore.md`
- `docs/runbooks/m6-storage-pressure.md`
- `docs/runbooks/m6-key-rotation.md`
- `docs/runbooks/m6-purge-repair.md`
- `docs/runbooks/m6-learning-rollback.md`
- `tests/recovery/interrupted-projection-rebuild.recovery.test.ts`
- `tests/recovery/complete-purge-audit.recovery.test.ts`
- `tests/security/operational-artifact-residual.test.ts`
- `tests/integration/operator-destructive-confirmation.integration.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Characterize rebuild, purge retry, residual scan, learning rollback, and
      existing runbook patterns.
- [ ] Enumerate every supported artifact class and store owner.
- [ ] Define dry-run/confirmation/current-state digest fields.
- [ ] Bind canonical intent, root/source/target/anchor, principal, expected
      frontiers/config/key state, nonce, expiry, and atomic consumption.
- [ ] Define salvage quarantine boundary and prove it cannot publish.

### Test-first checklist

- [ ] Dry run emits canonical digest/frontier without effect.
- [ ] Missing/generic/stale/mismatched digest confirmation produces zero
      effects.
- [ ] Payload/effect process without the separately opened confirmation
      signing key cannot manufacture an operator grant.
- [ ] Reject unknown/self-signed/wrong-purpose/expired/revoked confirmation
      identities; grant/payload cannot replace the trusted configured
      verifier.
- [ ] Cross-command/target, expired, restart-replayed, and concurrent
      double-submitted confirmation produces at most one effect/receipt.
- [ ] State change between dry run and execution invalidates confirmation.
- [ ] Terminate at `authorized`, `effect_prepared`, `effect_committed`,
      `receipt_committed`, and `responded`; restart returns/reconciles exactly
      once without repeating an external/filesystem effect.
- [ ] Rebuild interruption leaves named degraded state and resumes from
      canonical source.
- [ ] Only current revision becomes model-visible after rebuild.
- [ ] Purge fixture spans canonical, Context, projection, learning, backup,
      log, temp, quarantine, and ciphertext classes.
- [ ] Missing/unreadable store outcome blocks purge completion.
- [ ] Authorized retry is idempotent and cannot rewrite history.
- [ ] Salvage output cannot be selected as restore/rebuild source.
- [ ] Every runbook automation output matches the shared schema.
- [ ] Human instructions match actual command flags, states, and abort rules.
- [ ] Global marker scan covers runbook output and receipts.

### Implementation checklist

- [ ] Add operational action/dry-run/confirmation/receipt contracts.
- [ ] Add `OperatorConfirmationAuthority`: trusted-terminal signer loads a
      private local key; effect executor receives only signature/verifier ID.
- [ ] Freeze confirmation algorithm, key ID, purpose domain, pinned public
      verifier, expiry, rotation, and revocation in trusted operator config;
      never resolve verifier material from a grant/request.
- [ ] Add the external fsynced operator-action ledger saga for cross-resource
      effects.
- [ ] Register all artifact classes and typed purge outcomes.
- [ ] Reuse U2's versioned store registry and per-store purge frontier/debt.
- [ ] Add exact authorized purge retry and projection rebuild.
- [ ] Add content-free operational receipts.
- [ ] Add rebuild/purge-audit/key/restore/rollback/g6 verify commands.
- [ ] Register every command explicitly in `apps/operator-cli/src/cli.ts`.
- [ ] Close the full U2/U3/U4 concrete maintenance compatibility matrix.
- [ ] Add executable runbooks with prerequisites, expected observations,
      failure stop, rollback, and evidence paths.
- [ ] Keep metrics/logs non-authoritative.
- [ ] Keep salvage quarantined and out of automatic paths.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/recovery/interrupted-projection-rebuild.recovery.test.ts \
  tests/recovery/complete-purge-audit.recovery.test.ts \
  tests/security/operational-artifact-residual.test.ts \
  tests/integration/operator-destructive-confirmation.integration.test.ts
pnpm test:recovery
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Every effect is digest-confirmed and receipt-bound.
- [ ] Every purge artifact class has an explicit verified outcome.
- [ ] Runbooks are executable and content-free.
- [ ] `trellis-check` has no unresolved finding.
- [ ] Create only the U5 commit.

**Rollback point:** disable effect-bearing CLI commands; retain doctor and the
last verified core runtime.

## 8. U9 — Qualify governed secret admission behind G6 release control

**Requirements:** R2-R3, R7, R14-R15, R18-R20; secret lifecycle; M6 AE8.

**Depends on:** U2-U5.

**Files:**

- `packages/contracts/src/{mcp,tool-inputs,receipts}.ts`
- `packages/storage-sqlite/src/{database,governance-repository,client,protocol}.ts`
- `packages/memory-kernel/src/{approval,index}.ts`
- `packages/mcp-server/src/{index,cli}.ts`
- `apps/operator-cli/src/cli.ts`
- `apps/operator-cli/src/config.ts`
- `apps/operator-cli/src/secret-admission-authority.ts`
- `apps/operator-cli/src/commands/secret.ts`
- `apps/operator-cli/src/commands/key.ts`
- `tests/storage/encryption-key-lifecycle.integration.test.ts`
- `tests/integration/governed-secret-admission.integration.test.ts`
- `tests/security/secret-at-rest.test.ts`
- `tests/recovery/encrypted-backup-restore.recovery.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Confirm U2 dark-launch schema/key/rotation, U3 complete recovery, U4
      root/admission bounds, and U5 purge/runbook gates pass.
- [ ] Reopen the dark-launched `SecretAdmissionApproval`, sole-ingress tool,
      and transactional consumption contract.
- [ ] Freeze distinct admission signing and commitment keys, trusted pinned
      verifier, descriptor/stat binding, bounded size, and two-stage
      approve/admit flow.
- [ ] Confirm `G6ReleaseControl` defaults absent and normal admission remains
      `ENCRYPTION_REQUIRED`.
- [ ] Confirm default recall/Context remains `SECRET_EXCLUDED`.

### Test-first checklist

- [ ] Missing, stale, reused, wrong-principal/scope/owner/request/key/version/
      fence/expiry `SecretAdmissionApproval` produces zero effect.
- [ ] Available key without authority and authority without key both fail.
- [ ] Root fence, maintenance, or pressure drift before enqueue/transaction
      produces zero effect and no consumed approval.
- [ ] Missing/malformed/NO-GO/false-capability/drifted release control keeps
      normal admission at `ENCRYPTION_REQUIRED`.
- [ ] Synthetic exact GO-control fixture plus authorization produces one
      encrypted artifact, canonical effect, consumed approval, receipt, and
      frontier movement.
- [ ] Operator private inherited descriptor is the sole plaintext ingress.
      Every MCP tool rejects secret plaintext and may only reference an
      existing encrypted evidence identity.
- [ ] Empty/oversized/short-read/read-error/non-regular/non-seekable/wrong-
      owner/mode/changed/replaced descriptor fails before enqueue.
- [ ] Unknown/self-signed/wrong-purpose/expired/revoked admission signer or
      stat/HMAC mismatch produces zero canonical effect.
- [ ] No unkeyed plaintext hash or marker appears in DB/WAL/SHM/journal,
      temp/staging/quarantine/backup, logs, diagnostics, evidence, or tests.
- [ ] Standard MCP recall, Context, FTS, and projections cannot serve secret
      content.
- [ ] Admission → restart → rotation → backup → restore → purge passes M6 AE8
      under the synthetic fixture and leaves no supported decryptable result.
- [ ] The committed normal runtime has no current release-control artifact.

### Implementation checklist

- [ ] Bind `SecretAdmissionApproval` to principal/owner/scope/request/envelope/
      current-key/root-fence identity and expiry.
- [ ] Implement `SecretAdmissionAuthority` approval from one still-open
      regular seekable descriptor: approve preads and signs stat identity plus
      request-nonce-scoped HMAC; admit rechecks before/after pread and
      recomputes through a purpose-specific commitment key.
- [ ] Load the admission pinned verifier/commitment key only from trusted
      config; admit never receives the private signing key.
- [ ] Recheck approval, key, root fence, capacity, and maintenance before
      enqueue and transaction.
- [ ] Consume approval atomically with canonical effect/receipt.
- [ ] Add strict `G6ReleaseControl` verification; only exact-envelope GO with
      `secret_admission_allowed=true` may pass.
- [ ] Consume U2's G6 control and `RuntimeIdentityProvider` contracts; add
      default-off runtime enforcement without changing their authority.
- [ ] Route authorized operator descriptor input through
      `SecretIngressCoordinator`; never through MCP.
- [ ] Use synthetic controls in tests only; keep the real/current control
      absent until U8.
- [ ] Preserve `SECRET_EXCLUDED` for standard retrieval/Context.
- [ ] Keep an explicit forward switch to disable new secret admission while
      preserving 0015-aware recovery/rotation/purge.

### Focused verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm vitest run \
  tests/storage/encryption-key-lifecycle.integration.test.ts \
  tests/integration/governed-secret-admission.integration.test.ts \
  tests/security/secret-at-rest.test.ts \
  tests/recovery/encrypted-backup-restore.recovery.test.ts
pnpm test:storage
pnpm test:recovery
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] Secret admission is only qualified; committed normal admission remains
      disabled without an exact U8 control.
- [ ] M6 AE8 passes under the synthetic GO fixture and model eligibility
      remains excluded.
- [ ] `trellis-check` has no unresolved finding.
- [ ] Create only the U9 commit.

**Rollback point:** remove the qualification path or keep release control
absent while retaining 0015-aware open/backup/restore/rotation/purge/export.
Never revert the migration or persist plaintext.

## 9. U6 — Frozen G6 harness and independent review boundary

**Requirements:** R1-R20; all operational flows; M6 AE1-AE8.

**Depends on:** U1-U5 and U9.

**Files:**

- `fixtures/g6/manifest.json`
- `fixtures/g6/thresholds.json`
- `fixtures/g6/release-control.json`
- `fixtures/g6/decision-authority.json`
- `fixtures/g6/runtime-inputs.json`
- `fixtures/g6/{faults,recovery,resources,runbooks,security}/*`
- `scripts/g6-bootstrap.mjs`
- `scripts/g6-evidence-common.mjs`
- `scripts/run-g6-fault-matrix.mjs`
- `scripts/run-g6-resource-report.mjs`
- `scripts/run-g6-runbooks.mjs`
- `scripts/build-g6-manifest.mjs`
- `scripts/build-g6-runtime-identity.mjs`
- `scripts/build-g6-release-control.mjs`
- `scripts/verify-g6-evidence.mjs`
- `scripts/verify-g6-evidence.d.mts`
- `package.json`
- `tests/fixtures/g6.fixture.test.ts`
- `tests/integration/g6-artifact-integrity.test.ts`
- `tests/security/g6-evidence-redaction.test.ts`

### Pre-development

- [ ] Load `trellis-before-dev`.
- [ ] Freeze exact accepted G3R/G4A/G4B/G5 identities.
- [ ] Inventory every M6 AE1-AE8 proof and every fault seam from U1-U5 and U9.
- [ ] Freeze `G6ReleaseControl` schema/digest/signature plus pending/GO/NO-GO
      fixtures; no fixture is a current runtime release control.
- [ ] Freeze offline `G6DecisionAuthority` algorithm/key ID/pinned public key/
      expiry/rotation/revocation; runtime has no private signing key.
- [ ] Freeze runtime/contract/migration/dependency/native/build input allowlist
      for `tested_implementation_digest`; explicitly exclude U7 evidence and
      U8 decision/handoff paths.
- [ ] Freeze critical hard-rule order before evidence.
- [ ] Define allowed evidence/decision path sets.
- [ ] Define frozen-lock, native-build, and JSON audit blocked/fail policy.
- [ ] Freeze package-manager config, lock/store/tarball integrity, every
      lifecycle script/native addon source/hash, runtime-download prohibition,
      SBOM/provenance, vulnerability severity, and expiring waiver policy.

### Test-first checklist

- [ ] Reject manifest with missing/duplicate family, fault point, workload,
      threshold, runbook step, AE mapping, or prior gate.
- [ ] Reject fixture path/content/hash/partition/environment mismatch.
- [ ] Reject changed hard-rule order or empty critical group.
- [ ] Prove every M6 AE has a success and relevant failure Oracle.
- [ ] Prove every fault report must assert old-or-new, receipt/frontier,
      restart idempotency, and no resurrection.
- [ ] Reject production/fleet/multi-platform/SLO claim fields.
- [ ] Reject graph/vector enabled or automatic learning publication.
- [ ] Reject raw paths/content/ciphertext/key marker in any evidence object.
- [ ] Reject stable plaintext-derived content/path hashes and cross-bundle
      linkability; allow repository source hashes only in source binding.
- [ ] Reject unapproved native build, lock drift, migration drift, dirty source,
      and registry failure reported as pass.
- [ ] Reject store/tarball tampering, new lifecycle script/native addon,
      unbound runtime download, missing SBOM/provenance, and expired waiver.
- [ ] Prove clean bootstrap keeps lifecycle scripts disabled until lock,
      tarball, SBOM, provenance, and allowlist verification; only approved
      builds run and output hashes verify before candidate/verifier code.
- [ ] Reject missing/extra/unbound evidence paths.
- [ ] Prove first-false order is deterministic.

### Implementation checklist

- [ ] Freeze fault/security/recovery/resource/runbook fixtures.
- [ ] Freeze Small/Expected thresholds and identities.
- [ ] Add common candidate/environment/migration/source binding helpers.
- [ ] Add runtime identity builder matching the U9 provider contract.
- [ ] Add and test the precommitted release-control signer; U8 only executes
      it and cannot author signing logic.
- [ ] Add fault, resource, and runbook report runners.
- [ ] Add manifest builder with raw/canonical report bindings.
- [ ] Add SBOM/provenance and package/store/native/lifecycle bindings.
- [ ] Add scripts-disabled clean bootstrap and explicit approved-native build
      execution.
- [ ] Add independent verifier and declaration typecheck.
- [ ] Add root `g6:*` and `verify:g6` scripts.
- [ ] Add fixture, integrity, and redaction tests.
- [ ] Run full code review of the committed U1-U5 and U9 diff.
- [ ] Dispatch correctness, maintainability, testing, standards, security,
      data-integrity, reliability, performance, and API-contract reviewers
      required by the review skill.
- [ ] Resolve every verified P0/P1 in a new remediation U-ID/commit, then
      rebuild/re-review the candidate before U7.
- [ ] Record lower-priority debt without weakening G6.

### Focused and full verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm test:fixtures
pnpm vitest run \
  tests/integration/g6-artifact-integrity.test.ts \
  tests/security/g6-evidence-redaction.test.ts
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

### Completion evidence

- [ ] Harness, verifier, fixtures, thresholds, and reviews are committed before
      evidence capture.
- [ ] All AE/fault/hard-rule families are frozen and hash-bound.
- [ ] No unresolved verified P0/P1 remains.
- [ ] `trellis-check` has no unresolved finding.
- [ ] Create only the U6 commit or the separately planned remediation commit.

**Rollback point:** revert U6 harness changes; hardened runtime remains but G6
is unevaluated.

## 10. U7 — Immutable G6 evidence

**Requirements:** R1-R20; all operational flows; M6 AE1-AE8.

**Depends on:** clean committed U6 candidate or first immutable hard stop.

**Files:**

- `docs/evaluations/g6-fault-report.json`
- `docs/evaluations/g6-resource-report.json`
- `docs/evaluations/g6-runbook-report.json`
- `docs/evaluations/g6-security-report.json`
- `docs/evaluations/g6-supply-chain-report.json`
- `docs/evaluations/g6-code-review.md`
- `docs/evaluations/g6-reproducibility-manifest.json`
- `docs/evaluations/g6-verification-report.json`
- no plan/task metadata changes

### Pre-evidence gate

- [ ] Worktree is clean on one committed reviewed candidate.
- [ ] Record commit/tree, lock hash, migration set, runtime/platform/
      filesystem, config, thresholds, fixtures, keys-by-ID, and prior gates.
- [ ] Recompute and record `tested_implementation_digest` over the frozen
      runtime/build allowlist separately from repository commit/tree.
- [ ] Confirm graph/vector disabled and learning auto-publication disabled.
- [ ] Confirm every evidence runner/verifier is part of the candidate.
- [ ] Confirm no candidate code changes are permitted during evidence.
- [ ] Confirm tested implementation hash, precommitted evaluator hash, and
      future evidence-bundle hash are distinct identities.

### Evidence matrix

- [ ] Run complete fault/recovery matrix.
- [ ] Run encryption/key/wrong-key/rotation/residual matrix.
- [ ] Run backup/restore/external-anchor/deletion matrix.
- [ ] Run queue/disk/WAL/checkpoint/maintenance resource matrix.
- [ ] Run M6 AE1-AE8 combined integration paths.
- [ ] Verify synthetic GO/NO-GO/drift release-control enforcement without
      creating or installing a current control.
- [ ] Run learning pause/restore/monitor/rollback paths.
- [ ] Exercise every runbook through its declared automation path.
- [ ] Run frozen-lock install/check.
- [ ] Run approved native-build verification.
- [ ] Verify package-manager config, lock/store/tarball integrity, lifecycle
      scripts/native addons, no unbound runtime download, SBOM/provenance, and
      waiver expiry.
- [ ] Run `pnpm audit --json` with the frozen severity policy; record registry
      unavailability as blocked.
- [ ] Run full test/lint/typecheck/build and artifact-integrity suites.
- [ ] Bind independent review result and lower-priority debt.

### Verifier checklist

- [ ] Recompute source commit/tree and dependency lock.
- [ ] Recompute the allowlisted runtime/build implementation digest and prove
      U7 evidence paths are excluded.
- [ ] Recompute migration set, environment, filesystem, config, fixtures, and
      thresholds.
- [ ] Recompute every raw/canonical report hash.
- [ ] Verify prior G3R/G4A/G4B/G5 decisions and active fallback.
- [ ] Verify graph/vector disabled and learning publication disabled.
- [ ] Verify each critical rule conjunctively in fixed order.
- [ ] Verify allowed dirty/evidence path policy.
- [ ] Verify content-free evidence and exact-platform boundary.
- [ ] Emit first false/blocked rule and rerun boundary.
- [ ] Leave `decision_recorded=false`.
- [ ] Confirm no current G6 release-control artifact exists in U7.

### Full verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm g6:faults
pnpm g6:resources
pnpm g6:runbooks
pnpm g6:manifest
pnpm verify:g6
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

### Completion evidence

- [ ] All reports bind one candidate or name the first immutable hard stop.
- [ ] Independent verifier reproduces every binding and decision input.
- [ ] No terminal G6 decision appears in U7.
- [ ] Create only the U7 evidence commit.

**Rollback point:** regenerate/remove evidence from the same candidate; any
implementation change requires a new committed candidate and evidence run.

## 11. U8 — G6 decision and parent handoff

**Requirements:** R1-R20; final release gate; M6 AE1-AE8.

**Depends on:** U7 or first immutable hard-stop evidence.

**Files:**

- `docs/evaluations/g6-decision.md`
- `docs/evaluations/g6-handoff.md`
- `docs/evaluations/g6-release-control.json`
- `docs/adr/0006-local-operational-release-baseline.md`
- `docs/plans/2026-07-30-001-feat-agent-memory-runtime-m6-operational-hardening-plan.md`
- `docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md`
- `.trellis/tasks/07-30-agent-memory-runtime-m6/task.json`
- `.trellis/tasks/07-30-agent-memory-runtime-m6/implement.md`
- `README.md`
- `.trellis/spec/backend/database-guidelines.md`

### Decision checklist

- [x] Read the committed G6 verification report.
- [x] Confirm tested implementation and evidence commits are immutable.
- [x] Identify the first false/blocked hard rule, if any.
- [x] Confirm exact platform, lock, filesystem, schema, configuration,
      thresholds, fixtures, key IDs, and prior gate decisions.
- [x] Confirm active learning/base pointer and exact rollback.
- [x] Confirm graph/vector decisions are unchanged.
- [x] Record exactly one result:
  - [ ] `GO` only if every required rule is true and none is blocked.
  - [x] `NO-GO` on the first false/blocked/missing rule.
- [x] Create the only current `G6ReleaseControl`, bound to the exact tested
      envelope; set `secret_admission_allowed=true` only for GO.
- [x] Execute only U6's precommitted `build-g6-release-control.mjs`; do not
      author or modify signer behavior in U8.
- [x] Load the offline decision private key from a verified restricted local
      file, sign with the U6 `G6DecisionAuthority`, and leave runtime with only
      the pinned verifier.
- [x] Reject unknown/expired/revoked/wrong-key/candidate-minted controls.
- [x] Prove U7 evidence and U8 decision/handoff paths do not change
      `tested_implementation_digest`, while runtime/contract/migration/
      dependency/native/build drift does.
- [x] Verify NO-GO control remains non-enabling and any source/lock/platform/
      schema/config/key drift reports `outside_tested_envelope`.
- [x] Scope `GO` only to the exact local topology and explicitly disclaim
      production/fleet/multi-platform/SLO claims.
- [x] On `NO-GO`, preserve the last verified fallback and rerun boundary.
- [x] Update ADR, parent roadmap, plan, task, README, and backend spec to the
      same result.
- [x] Do not rewrite or regenerate U7 evidence.

### Final verification

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm verify:g6
pnpm test
pnpm lint
pnpm typecheck
pnpm build
python3 .trellis/scripts/task.py validate \
  .trellis/tasks/07-30-agent-memory-runtime-m6
git diff --check
```

### Completion evidence

- [x] One verifier-backed G6 outcome exists.
- [x] The release-control artifact exactly matches that outcome and cannot
      enable outside the tested envelope.
- [x] Parent/ADR/plan/task/README/spec agree.
- [x] Accepted fallback remains independently runnable.
- [x] Create only the U8 decision commit.

**Rollback point:** revert only U8 documentation/metadata; U7 evidence and the
tested implementation remain immutable.

## 12. Closure — separate archive, journal, and parent-roadmap commits

After U8 is committed:

### M6 archive task

- [ ] Re-run `task.py validate`.
- [ ] Confirm all nine units (U1, U4, U2, U3, U5, U9, U6, U7, U8) are honestly
      checked or the terminal
      NO-GO boundary is explicitly recorded.
- [ ] Archive the M6 child with Trellis.
- [ ] Confirm the parent link resolves to the archive.
- [ ] Create only the M6 archive commit.

### M6 journal task

- [ ] Record branch/baseline, brainstorm, research run/gate, plan, activation,
      all nine unit/remediation commits, tested/evidence/decision identities, G6
      outcome, fallback, limitations, and parent-closure handoff status/next
      steps.
- [ ] Update workspace index through the supported session script.
- [ ] Create only the M6 journal commit.

### Parent-roadmap status task

- [ ] Reopen the parent PRD/design/implement/plan and every archived child.
- [ ] Verify M0-M6 gate outcomes and decision paths are mutually consistent.
- [ ] Run final integration/full quality/Trellis/Markdown/diff checks.
- [ ] Mark parent completion without converting local/synthetic results into
      production claims.
- [ ] Create only the parent roadmap-status commit.

### Parent archive task

- [ ] Revalidate the completed parent task and all child links.
- [ ] Archive the parent through the supported Trellis command.
- [ ] Verify archived metadata and links without changing roadmap prose.
- [ ] Create only the parent archive commit.

### Parent journal task

- [ ] Record the actual parent terminal result, M0-M6 gates, status/archive
      commits, exact fallback, limitations, and clean-worktree evidence.
- [ ] Update the workspace index through the supported session script.
- [ ] Create only the parent journal commit.
- [ ] Confirm the worktree is clean.

## 13. Global G6 rule

G6 `GO` is legal only when every frozen integrity, correctness, governance,
recovery, privacy, deletion, encryption, restore, rollback, resource,
operator, supply-chain, evidence-binding, and review hard rule is true for one
exact candidate.

The first false, blocked, or missing critical rule makes G6 `NO-GO`. A
supported NO-GO:

- preserves the last verified local runtime/fallback;
- keeps graph/vector disabled;
- keeps automatic learning publication disabled;
- records the exact first-false evidence and rerun boundary;
- makes no production-readiness claim;
- closes M6 and permits honest parent-roadmap closure.

Only U8 records the terminal decision. U7 records evidence and may not decide
by aggregate score or narrative judgment.
