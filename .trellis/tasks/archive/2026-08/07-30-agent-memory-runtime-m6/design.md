# Agent Memory Runtime M6 — Technical Design

## 1. Objective

M6 turns the accepted local Memory Runtime into one diagnosable, recoverable,
resource-bounded exact-platform release candidate. It adds:

- a shared content-free operational contract;
- a local operator CLI and blocked-runtime MCP health shell;
- application-level AEAD persistence and bounded key lifecycle for `secret`;
- complete backup manifests and external-anchor restore;
- bounded queue/disk/WAL/maintenance admission;
- repair, purge audit, operational receipts, and executable runbooks;
- one immutable G6 evidence bundle, verifier, and terminal decision.

The design has two complete outcomes:

- **G6 GO:** every frozen critical rule passes for one exact local
  single-user/root/writer/stdio candidate.
- **G6 NO-GO:** the first false or blocked critical rule, last verified
  fallback, and rerun boundary are preserved; the roadmap closes without
  claiming production readiness.

## 2. Authority and traceability

1. Product Contract R1-R20 and Product flows F1-F4 remain the product
   requirement identifiers. The M6 operational acceptance examples AE1-AE8
   are a scoped verification namespace owned by the M6 requirements document
   and are referenced below as **M6 AE1-AE8**.
2. `docs/brainstorms/2026-07-30-m6-operational-hardening-requirements.md`
   owns the scoped M6 interpretation and operational flow descriptions.
3. `prd.md` owns Trellis acceptance.
4. `research/research-handoff.md` and `research/claim-map.md` own the
   Claim/Evidence transfer.
5. This document owns component, persistence, key, readiness, maintenance,
   recovery, operator, and gate boundaries.
6. `implement.md` owns U-ID sequence, test-first execution, hard stops,
   rollback points, and one-task/one-commit delivery.
7. `docs/plans/2026-07-30-001-feat-agent-memory-runtime-m6-operational-hardening-plan.md`
   is the unified implementation view.
8. G6 reports and the evidence verifier own tested facts. Only the later G6
   decision artifact may record the terminal gate outcome.

## 3. Accepted immutable baseline

| Input | Accepted value |
| --- | --- |
| Baseline branch | `codex/agent-memory-runtime-m5` |
| Baseline commit | `de1a4db3bfdd11446cd14687676c099afcacfadf` |
| Canonical authority | SQLite through one dedicated storage worker |
| Runtime | Node 24.18.0, pnpm 10.33.2, TypeScript strict ESM |
| G3R | `GO` at `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| G4A | graph `NO-GO` at `36421f5cd75007a1421d3e0594e7881dd4b864b2` |
| G4B | vector `NO-GO` at `3eec7119b1e441d76523d0a57c328d4d811a4af3` |
| G5 | qualified local synthetic path; automatic publication disabled |
| Supported topology | one local user, root, serialized writer, stdio MCP |
| Restore | new absent target only |
| Secret baseline | fail closed with `ENCRYPTION_REQUIRED` |

Every G6 report binds the exact source tree, lock, migration set, environment,
filesystem, configuration, thresholds, fixtures, and prior decisions. Any
change creates a different candidate.

## 4. Component boundaries

### 4.1 Contracts

`@memo-graph/contracts` owns:

- top-level readiness, component/maintenance state, reason and action codes;
- release qualification independent from readiness:
  `pending | GO | NO-GO | outside_tested_envelope`, with exact tested-envelope
  digest when applicable;
- content-free measurement, diagnostic, operator result, and receipt shapes;
- recovery anchors and complete backup manifests;
- AEAD envelope metadata, authenticated identity, key state, and rotation
  receipts;
- G6 fixture/report/manifest/verification and signed release-control
  envelopes.

Contracts contain no filesystem access, crypto execution, SQLite, MCP SDK,
argument parsing, or renderer logic. Every external/persisted input enters as
`unknown` and is parsed exactly once.

### 4.2 SQLite storage

`@memo-graph/storage-sqlite` owns:

- nonce reservation and a non-exported main-thread
  `SecretIngressCoordinator` that is the sole storage plaintext-ingestion
  boundary and encrypts before worker structured-clone/durable storage;
  decryption is limited to exact purpose-bound internal operations;
- ciphertext artifacts and the canonical-to-physical identity mapping;
- key identity/state/rotation progress and append-only receipts;
- exclusive data-root fence/lease, heartbeat, and stale-owner recovery;
- schema migration, canonical state, frontiers, maintenance state, admission,
  checkpoint, online backup, restore verification, and purge outcomes;
- content-free health observations;
- deterministic test-only fault seams.

The worker is the sole SQLite owner. Storage does not parse CLI arguments or
MCP transport requests.

### 4.3 Operator CLI

`apps/operator-cli` owns:

- provider path selection and opened-file loading after owner/mode/type/size/
  symlink/TOCTOU checks; raw key values never appear in argv, environment
  values, or inline config;
- command parsing, JSON/human renderers, stable exit classes;
- read-only doctor/inspection;
- dry-run digest and exact confirmation for restore, rebuild, purge retry,
  key mutation, and rollback;
- operator-only secret admission from a private inherited file descriptor,
  never argv/environment/config/MCP payload;
- orchestration through public storage/runtime APIs.

It has no direct `better-sqlite3` access and never prints memory, Context,
queries, ciphertext bytes, raw keys, tokens, or raw paths.
Effect-bearing commands require the MCP runtime stopped and the same fenced
exclusive root lease; enumerated read-only inspection is the only concurrent
operator mode.

### 4.4 Memory kernel and MCP

Memory kernel maps operational storage state into existing governed
read/write behavior. Verified non-secret reads may continue in safe
read-only/degraded states; no-match remains distinct from operational failure.

MCP:

- serves normal tools only after a verified full runtime open;
- serves content-free health through a preflight shell when full open blocks;
- keeps administrative/offline effects out of routine MCP mutations;
- rejects secret plaintext on every MCP tool; tools may reference an existing
  encrypted evidence identity but cannot originate plaintext admission;
- keeps secret content excluded from normal recall and model Context.

### 4.5 G6 harness

Fixtures and scripts own deterministic workloads, fault points, thresholds,
expected Oracles, report generation, source binding, and first-false
verification. They do not mutate the tested implementation after its commit.

## 5. Operational contract

### 5.1 Top-level readiness

| State | Meaning | Permitted behavior |
| --- | --- | --- |
| `ready` | all required canonical, key, resource, and frontier checks pass | governed reads and admitted writes |
| `degraded` | optional/rebuildable component unavailable or rebuilding | verified baseline reads; only declared safe effects |
| `read_only` | canonical integrity is readable but write preconditions fail | verified reads, doctor, backup where safe; no canonical mutation |
| `blocked` | schema/integrity/key/authority state cannot support serving | content-free health and explicit offline recovery only |

`rebuilding` is a component/maintenance state. `repairable` is a recovery
action class. They never become competing top-level states.

### 5.2 Release qualification

Readiness answers whether the runtime can safely serve now. Qualification
answers whether the exact source/lock/platform/schema/configuration candidate
has a terminal G6 decision. A `ready` runtime can be `pending` or
`outside_tested_envelope`; a qualified runtime can later be `degraded`.
Doctor, MCP health, and release output expose both fields without deriving one
from the other.

Only U8 may create the current `G6ReleaseControl`. It binds the exact tested
envelope and sets `secret_admission_allowed=true` only for `GO`. Missing,
`NO-GO`, false-capability, malformed, or drifted control preserves
`ENCRYPTION_REQUIRED`.

### 5.3 Reason ordering

The reducer uses deterministic severity and stable code ordering. Canonical
integrity/schema/key failures outrank resource pressure; resource pressure
outranks optional projection degradation. Multiple reasons remain visible,
but the first reason determines the exit class and immediate safe action.

### 5.4 Allowed fields

Allowed fields include:

- time, component, operation, readiness/component/maintenance state;
- stable reason/action/exit codes;
- duration, capacity, queue, checkpoint, and count values;
- schema/config/version identities;
- receipt, epoch, frontier, opaque operation, and bundle-local identities;
- repository-source artifact hashes only inside the G6 source-binding
  manifest.

Forbidden fields include:

- memory, evidence, Context, tool/request/search bodies;
- plaintext, ciphertext bytes, raw key material, token/credential values;
- raw local paths or environment variable values;
- stable plaintext-derived content/path hashes on CLI, MCP, logs, diagnostics,
  or committed operational reports. Use opaque IDs, keyed context-specific
  pseudonyms, or bundle-local aliases instead.

Logs and metrics are observations. Append-only operational receipts remain the
audit authority.

## 6. Encryption and key lifecycle

### 6.1 Envelope

The versioned AEAD envelope binds:

- AES-256-GCM envelope version 1;
- a 32-byte encryption key selected by key ID, fresh 12-byte nonce, and
  16-byte tag;
- authentication tag and ciphertext artifact identity;
- keyed, owner/scope-specific plaintext commitment rather than an unkeyed
  low-entropy secret hash;
- evidence/memory/revision identity;
- exact scope, sensitivity, and content class.

AAD bytes are the UTF-8 domain separator
`memo-graph/secret-envelope/v1` followed by canonical JSON bytes of the
versioned metadata. Any unknown suite/length/encoding or mismatch fails before
plaintext is returned.

The storage worker reserves the nonce in durable prepared state and enforces a
database unique constraint on `(key_id, nonce)`. Retry after crash reuses a
nonce only when the prepared row's key generation, canonical AAD hash, keyed
plaintext commitment, owner generation, and request digest all match exactly.
Prefer resuming already persisted ciphertext. Changed input under the same
idempotency key fails closed and never re-encrypts with that nonce.
Concurrency, restart, rotation, and collision tests must prove uniqueness.

### 6.2 Durable boundary

```text
validated operator private-descriptor plaintext
  → reserve operation + nonce in worker
  → build canonical domain-separated AAD
  → private main-thread SecretIngressCoordinator encrypts in memory
  → zero plaintext buffer best-effort
  → send ciphertext/envelope metadata through worker IPC
  ├─ inline/default
  │    → atomically commit ciphertext + owner reference + receipt + frontier
  └─ existing blob-eligible payload only
       → persist and fsync ciphertext temp
       → prepared/committed/retired reconciliation
       → atomically bind owner reference/receipt/frontier
```

No plaintext enters SQLite, WAL, FTS, projection outboxes, blob temp files,
worker structured-clone IPC, outward storage results, backups, logs,
diagnostics, receipts, or evidence.

### 6.3 Key states

```text
unavailable ──provider supplies current──> current
new key ──rotation begins───────────────> rotating_to
old current + rotating_to ──all rewritten──> old retired + new current
rotating_to ──abort before first rewrite──> unavailable
current/rotating_to/retired ──compromise──> revoked_or_compromised
```

- only `current` encrypts;
- `retired` decrypts existing ciphertext for exact authorized read/rotation;
- revoked/compromised and unavailable never decrypt through supported paths;
- unknown or multiple current keys block;
- raw keys are never persisted.

Rotation runs under exclusive maintenance and quiesces secret writes. The old
key remains the sole current key and decrypt-capable until every item is
rewritten. Completion atomically retires old, promotes new, and commits the
final receipt. Abort is legal only before the first item rewrite; afterward
recovery is roll-forward. There is never zero or more than one current key.

The provider accepts only exact 32-byte material from trusted opened regular
files outside argv/environment/inline config. It validates owner, private
mode, type, size, and link/replacement safety. Buffers are short-lived and
zeroed best-effort; core dumps are disabled in the tested G6 process. Process
memory/swap compromise remains out of scope.

Key availability is not authority. Every decrypt uses a single-use
`SecretUseAuthority` bound to local principal, operation class, owner,
scope, request digest, ciphertext/key identity, expiry, and receipt. Allowed
purposes are integrity verification, rotation, backup/restore verification,
and purge. There is no general plaintext read API.

Secret admission has a separate single-use `SecretAdmissionApproval` bound to
principal, owner, scope, request/envelope/key identity, current root fence, and
expiry. It is checked before enqueue and transactionally consumed with the
canonical effect. This is not an alias of the existing destructive-tool
approval contract.

Only the operator `secret admit --input-fd <n>` command may present plaintext
to the coordinator. The descriptor is inherited from a trusted local launcher
and is never echoed or reopened by path. Every MCP tool rejects secret
plaintext and may reference only already encrypted evidence, preserving the
deferred model-visibility boundary.

`SecretAdmissionAuthority` is a separate purpose-bound signer. The operator
keeps one private regular seekable secret descriptor open across:

```text
secret approve
  → pread bounded bytes + verify uid/mode/type/size/stat identity
  → compute request-nonce-scoped HMAC with admission commitment key
  → sign approval with private signing-key descriptor

secret admit
  → resolve pinned public verifier + commitment key from trusted config
  → recheck same descriptor identity before/after pread
  → recompute HMAC and validate single-use approval
  → SecretIngressCoordinator
```

The admit effect process never receives the signing key. Signing,
commitment, data-encryption, confirmation, recovery, and G6 keys are distinct.
Empty, oversized, short-read, read-error, changed, non-regular, non-seekable,
wrong-owner/mode, or replaced descriptors fail closed; retry requires a fresh
approval.

### 6.4 Secret visibility

M6 changes persistence, recovery, rotation, and purge capability. It does not
change default model eligibility. Secret content remains excluded from MCP
recall and Context Compiler paths even when the provider has the key.

U2 dark-launches these primitives while normal admission still returns
`ENCRYPTION_REQUIRED`. U9 qualifies the full path using synthetic release
controls but leaves normal admission disabled. U8 alone may issue the exact
G6 release-control artifact after a terminal `GO`; `NO-GO` leaves the path
disabled.

## 7. Migration and persistence

`0015-operational-hardening.sql` is forward-only and may introduce:

- inline encrypted content/envelope as the default atomic path, encrypted
  external-blob variant only above the frozen blob threshold, keyed
  commitment, owner-to-ciphertext mappings, `(key_id, nonce)` uniqueness, and
  envelope generation;
- key identity/state and rotation progress;
- maintenance state/lease;
- durable artifact operation state and orphan quarantine;
- versioned artifact-store registry plus per-store purge frontier/debt;
- operational action/receipt rows;
- backup/recovery anchor identities where durable evidence is required.

Existing CHECK-bound payload tables may require table-copy migration. The
migration must:

1. create the new validated shape;
2. copy existing non-secret rows without canonical identity change;
3. validate counts/foreign keys/checks;
4. swap in one transaction where SQLite permits;
5. leave no accepted secret plaintext backfill path;
6. fail before serving on interruption, drift, downgrade, or mismatch.

Applied migration files and hashes are immutable.

Before activation, the plan freezes the exact table-copy, trigger, index, and
foreign-key impact and requires a verified pre-upgrade backup. Once 0015 is
applied, code-only rollback is forbidden. Recovery is roll-forward with an
0015-aware binary or publish-new-root from the pre-migration backup. An older
binary must reject the new schema.

Inline ciphertext commits with its canonical effect/receipt/frontier in one
SQLite transaction. Only the existing blob-eligible external path uses the
idempotent file state machine:
`prepared → committed → retired`. Startup reconciliation compares the
operation row, owner reference, file/temp set, ciphertext hash, key state,
receipt, frontier, and purge debt. Unreferenced artifacts are quarantined or
removed by rule; they never become model-visible.

## 8. Admission, capacity, WAL, and maintenance

### 8.1 Observations

Health collects:

- data-root available bytes;
- database, WAL, backup, blob, and ciphertext sizes;
- queue depth, oldest age, completions, and rejections;
- checkpoint busy/log/checkpointed;
- active maintenance operation and digest;
- key readiness;
- root lease owner/fence/heartbeat and stale-recovery status;
- canonical, purge, projection, Context, and learning frontiers.

### 8.2 Two checks

```text
request
  → pre-enqueue readiness/policy check
  → bounded queue
  → transaction-start recheck
  → effect + idempotency + receipt + frontier
```

Any rejection before the transaction produces no durable effect. A request
accepted into the queue may still fail the transaction-start recheck and must
not execute later automatically. That attempt returns a terminal typed
rejection. A later explicit retry with the same idempotency key re-evaluates
policy; the old queue entry is never retained.

### 8.3 Hysteresis

The frozen policy has separate enter and recover thresholds. Recovery requires
both resource headroom and a successful canonical/checkpoint Oracle, avoiding
rapid writable/read-only flapping.

### 8.4 Maintenance compatibility

The implementation owns one exhaustive compatibility table for:

- doctor/read-only inspection;
- backup;
- checkpoint;
- FTS/layered/SQLite-relation rebuild;
- purge audit and retry;
- key inspection and rotation;
- restore publication;
- learning rollback verification.

Unknown combinations reject. Payloads cannot select test faults or bypass the
matrix.

U4 lands the reducer and rows for operations that already exist. U2 adds
encryption/rotation rows, U3 adds complete backup/restore rows, and U5 closes
the full concrete matrix. U4 therefore does not claim tests for operations
that have not yet been implemented.

### 8.5 Root exclusion

The runtime acquires an exclusive root-writer lease before opening for normal
service and records owner identity, monotonic fence, and heartbeat. An
effect-bearing CLI command requires the runtime stopped and acquires the same
lease before opening the writer. Read-only inspection modes are enumerated and
cannot mutate maintenance/receipts.

A stale lock cannot be removed implicitly. Recovery is its own digest-bound
operator action and requires proof that the recorded owner is not live,
heartbeat expiry, exact root identity, and monotonic fence advance. Ambiguous
PID/owner state stays blocked. This is local exclusion, not HA/failover.

## 9. Backup and restore

### 9.1 Complete manifest

The manifest binds:

- SQLite snapshot plus every blob/ciphertext hash and size;
- migration set and schema;
- ledger epoch, receipt hash, tombstone/purge frontier;
- FTS/layered/SQLite relation and Context frontiers;
- learning control, release version/pointer, monitor/rollback identity;
- required key IDs/states and encryption format, never raw keys;
- accepted graph/vector decisions and disabled state;
- config, environment, filesystem, and creation identity.

### 9.2 Recovery anchor

The operator supplies a separate hash-bound anchor with trusted minimum
frontiers and required key identities. It is operator-owned outside the data
root, bound to root/principal identity, and authenticated by a provider-held
recovery-authority key. A separately configured `RecoveryHeadProvider`,
outside both snapshot and anchor bundle, stores the current signed generation/
head using atomic replace and parent-directory fsync. Restore queries this
provider and never accepts a bundle's claim that its own head is current.

This is a versioned, authenticated extension of the existing caller-supplied
tombstone/learning minima seam, not a second canonical data authority. It
stores only current generation, minimum frontiers, required key identities,
and hashes. The added head is required specifically by the confirmed stale-
snapshot/joint-bundle replacement Oracle; it owns no memories or receipts.

```text
append + fsync signed pending reservation
  → commit SQLite effect with pending_id
  → append + fsync committed monotonic CAS head
  → reconcile anchored receipt
```

Startup reconciles a completed SQLite effect. Any unresolved pending
reservation remains a fail-closed minimum for startup and restore. If the
exact idempotent effect provably never began, reconciliation appends/fsyncs a
signed `aborted` entry against the same prior head; ambiguous state stays
blocked. The anchor is not read from the candidate snapshot, and a snapshot
cannot create/reset or lower it.

One storage-level `AnchorCoordinator` wraps the explicit protected operation
set: governed canonical admission/correction, control/revoke/delete/tombstone/
purge, Context/projection frontier publication, learning control/release/
rollback, key activation/retirement/revocation/rotation completion, and
installed G6 release-control identity. The concrete repositories must carry
the coordinator's `pending_id` in their transaction; it is not an optional
callback. MCP/operator composition injects the trusted provider and requests
cannot override it.

Missing, malformed, forged, old-but-valid, unauthorized-signer, trust-root
rotation mismatch, or newer-than-snapshot minima block publication. Replacing
snapshot+anchor while the separately retained head remains intact blocks.
Loss or rollback of the head provider/anchor trust root blocks automatic
restore; the runtime never guesses or resets minima. M6 does not claim to
resist a local administrator who compromises and rolls back that separate
provider.

### 9.3 Consistent snapshot cut

The worker acquires the fenced maintenance/root lease, freezes epoch, latest
receipt, and a versioned artifact inventory, then holds that cut through
SQLite online backup, artifact copy/hash, manifest write, and fsync. Mutations,
purge, and rotation are rejected during the cut. The manifest references only
the frozen inventory.

### 9.4 Restore state machine

```text
absent target
  → acquire fenced parent target-name reservation
  → create private staging
  → verify manifest/artifacts/keys/anchor
  → copy + fsync
  → open/migrate/verify canonical state
  → audit purge and learning frontiers
  → degrade/rebuild disposable state
  → write/fsync verified publication marker
  → close + fsync files/directories
  → audited exact-platform no-replace publish
  → fsync target parent directory
  → published target
```

The G6 Darwin envelope uses `renameatx_np(..., RENAME_EXCL)` through a
source-bound audited helper. Unsupported no-replace capability blocks rather
than falling back to check-then-rename. Before the publication commit point,
an error removes staging and the target remains absent. After publication,
interruption must leave a complete, marker-bound, reopenable target and
support idempotent response-loss reconciliation.

A derived failure can publish only a named safe degraded state after canonical
verification. Any unverified canonical, ciphertext, backup-generation, key,
or purge debt blocks publication; only rebuildable derived projection absence
may degrade.

## 10. Operator actions

### 10.1 Read-only

`doctor`, key identity inspection, backup verification, purge inventory, and
G6 evidence verification are read-only unless a subcommand explicitly
declares an effect.

### 10.2 Two-phase effects

Effect-bearing operations follow:

1. dry run parses all inputs and current state;
2. it returns a canonical digest binding command intent, root/source/target,
   recovery anchor, expected frontiers/config/key state, local principal,
   single-use nonce, and expiry;
3. an `OperatorConfirmationAuthority` signs that exact digest using a
   separately opened private local key in an explicit trusted-terminal step;
4. execution re-parses inputs and rechecks current state;
5. mismatch performs zero effects;
6. transaction-local success consumes confirmation with its effect/receipt;
7. cross-resource commands advance a separately fsynced operator-action
   ledger through `authorized → effect_prepared → effect_committed →
   receipt_committed → responded`.

A generic `--yes` or payload-carried authority is insufficient. Confirmation
cannot be replayed across commands, targets, restart, expiry, or concurrent
double submission. The effect executor has only the verifier identity, not the
signing key. Restart reconciles the operator-action ledger and returns the
recorded result without repeating the external/filesystem effect. This
separates payload self-authorization from operator intent; hostile theft of
the local confirmation key remains outside the M6 threat claim. Confirmation,
recovery-head, data-encryption, and G6 decision keys have distinct purpose/
domain identities and are never interchangeable.

The confirmation algorithm, purpose domain, key ID, pinned public verifier,
expiry, rotation, and revocation policy are loaded only from trusted operator
configuration. A grant may identify the expected key but cannot supply or
replace the verifier; unknown or self-signed identities fail before action
preparation.

### 10.3 Exit classes

The contracts expose stable semantic classes for success, degraded but
inspectable, operator action required/blocked, invalid input/confirmation, and
internal failure. Numeric process codes are owned in one CLI module and tested
for JSON/human parity.

## 11. Repair, purge, and salvage

- Rebuildable FTS/layered/SQLite relations come only from verified canonical
  SQLite state.
- Purge audit enumerates canonical, derived, backup, log, temp, quarantine,
  ciphertext, and learning artifact classes.
- Every store has `verified_removed`, `verified_ineligible`,
  `verified_retained_identity_only`, `retryable`, or `blocked` outcome.
- Purge cannot complete with an absent store result or supported decryptable
  content.
- SQLite salvage is quarantined offline output. It cannot overwrite/publish a
  data root or count as G6 recovery.

## 12. Fault Oracles

Test-only deterministic faults cover:

- migration table-copy/swap;
- canonical commit/receipt and worker response;
- encrypted temp/write/fsync/rename/reference commit and nonce/input seal;
- key rotation begin/item/completion/abort/compromise;
- recovery anchor pending/SQLite/CAS/reconciliation;
- operator confirmation and every action-ledger transition;
- root fence/heartbeat advance and target reservation/no-replace publish;
- secret-admission approval/ciphertext/canonical publication;
- backup database/artifact/manifest;
- restore copy/verify/migrate/fsync/publish;
- checkpoint busy/retry/convergence;
- every purge store outcome;
- projection rebuild publish;
- learning pointer rollback.

Every fault asserts:

- old-or-new canonical state;
- receipt, epoch, and frontier agreement;
- restart/retry idempotency;
- no deleted, secret, stale, or candidate-only resurrection;
- typed readiness/action after recovery.

## 13. G6 evidence

### 13.1 Frozen implementation

U6 commits fixtures, thresholds, harnesses, report schemas, manifest builder,
and verifier. U7 records evidence from a clean committed U6 tree. A review fix
creates a new committed candidate and invalidates prior evidence.

U2 already owns the authoritative `G6ReleaseControl` schema and injectable
`RuntimeIdentityProvider` required by the later default-off verifier. U6 freezes the
exact decision-authority identity, runtime/build input allowlist, runtime
identity builder, and release-control signer; it does not introduce a
competing contract.

`tested_implementation_digest` hashes the frozen runtime, contract, migration,
dependency, native-helper, and build inputs. U7 evidence and U8
decision/handoff paths are explicitly excluded. Repository commit/tree remain
evidence provenance fields, but U8 documentation changes do not invalidate the
runtime digest. Runtime recomputes the same allowlisted digest before accepting
a control.

### 13.2 Evidence groups

- combined fault/recovery;
- encryption/key/secret residual;
- backup/restore/deletion;
- resource/WAL/backpressure;
- learning rollback and pause continuity;
- operator/runbook execution;
- supply-chain: package-manager config, frozen lock/store and tarball
  integrity, lifecycle scripts/native addons and source hashes, prohibited
  runtime downloads, SBOM/provenance, vulnerability policy and expiring
  waivers; a clean scripts-disabled bootstrap verifies these before executing
  only approved native builds and then verifies their output hashes;
- full repository and independent review.

### 13.3 First-false decision

The verifier evaluates a fixed ordered critical-rule list. Any false or
unavailable integrity, privacy, deletion, encryption, restore, rollback,
supply-chain, or binding rule makes G6 ineligible. Registry failure is
`blocked`, not pass.

U7 leaves `decision_recorded=false` and creates no current release control. U8
records exactly one terminal outcome and creates the only current
`G6ReleaseControl`; `secret_admission_allowed` is true only for exact-envelope
`GO`.

A distinct offline `G6DecisionAuthority` signs that control. U6 freezes the
algorithm, key ID, pinned public verification key, expiry, rotation, and
revocation rules. Runtime code holds only the pinned verifier and cannot mint
a control. U8 opens the private decision key from a separate restricted local
file after verification. Unknown, expired, revoked, wrong-key, or
candidate-minted controls fail closed.

U6 also commits and tests `build-g6-release-control.mjs`. U8 only executes
that immutable signer against the U7 verification report and restricted
private key; no signing behavior is authored after evidence freeze.

## 14. Test matrix

| Boundary | Primary tests |
| --- | --- |
| Contracts/readiness | `tests/contract/operations.contract.test.ts` |
| Encryption/key | `tests/contract/encryption.contract.test.ts`, `tests/storage/encryption-key-lifecycle.integration.test.ts` |
| Secret residual | `tests/security/secret-at-rest.test.ts`, `tests/security/secret-content-residual.test.ts` |
| Blocked MCP/CLI parity | `tests/integration/operator-health-parity.integration.test.ts`, `tests/recovery/canonical-corruption-startup.recovery.test.ts` |
| Complete restore | `tests/recovery/complete-backup-restore.recovery.test.ts`, `tests/recovery/encrypted-backup-restore.recovery.test.ts` |
| M6 AE1/Context | `tests/integration/m6-restored-context-equivalence.integration.test.ts` |
| M6 AE2/rebuild | `tests/recovery/interrupted-projection-rebuild.recovery.test.ts` |
| M6 AE3/optional absence | `tests/recovery/disabled-optional-lanes-restore.recovery.test.ts` |
| M6 AE4/purge | `tests/recovery/complete-purge-audit.recovery.test.ts` |
| M6 AE5/pressure | `tests/recovery/storage-pressure.recovery.test.ts`, `tests/recovery/wal-checkpoint.recovery.test.ts` |
| Root writer exclusion | `tests/recovery/root-lease.recovery.test.ts` |
| M6 AE6/rollback | `tests/recovery/restored-learning-rollback.recovery.test.ts` |
| M6 AE7/pause | `tests/recovery/paused-learning-snapshot.recovery.test.ts` |
| CLI authority | `tests/integration/operator-destructive-confirmation.integration.test.ts` |
| Secret qualification | `tests/integration/governed-secret-admission.integration.test.ts` |
| G6 binding | `tests/fixtures/g6.fixture.test.ts`, `tests/integration/g6-artifact-integrity.test.ts` |

## 15. Compatibility and rollback

- Existing non-secret contracts and canonical hashes remain stable unless an
  explicitly versioned persisted artifact changes.
- Existing data roots upgrade forward; no migration downgrade is supported.
- After 0015 applies, rollback is roll-forward or publish-new-root from the
  verified pre-migration backup. An old binary rejects the schema. Disabling
  secret admission must retain 0015-aware backup/restore/rotation/purge
  capability for existing ciphertext.
- Graph/vector remain disabled and cannot become backup/startup dependencies.
- Learning remains candidate-only by default and the G5 release/control
  frontier is preserved.
- Each U-ID can be reverted to the prior verified behavior described in
  `implement.md`. Secret support may roll back only to fail-closed rejection,
  never plaintext persistence.
- A G6 `NO-GO` retains the last verified runtime and names the rerun boundary.

## 16. Hard stops

Stop the current unit and do not commit completion when:

- plaintext/key material appears in any durable or operational artifact;
- migration drift, partial canonical effect, receipt/frontier mismatch, or
  deletion/secret resurrection occurs;
- a restore publishes over an existing root or without a valid external
  anchor;
- a rejected write later executes;
- two writer processes acquire the same root fence or stale recovery steals a
  live/ambiguous lease;
- a model/MCP Context path begins serving secret content;
- plaintext, raw key, stable plaintext-derived secret/path hash, or general
  secret read crosses worker IPC/outward-result/render/evidence boundaries;
- graph/vector becomes required or learning publication becomes automatic;
- a registry/audit failure is treated as pass;
- evidence was generated from dirty or mixed candidate state;
- a verified P0/P1 review finding remains unresolved.
