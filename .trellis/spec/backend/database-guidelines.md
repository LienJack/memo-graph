# Database Guidelines

## Scenario: Canonical SQLite Ledger

### 1. Scope / Trigger

Use these rules for any SQLite connection, query, transaction, migration,
checkpoint, backup, restore, FTS index, or derived projection.

### 2. Signatures

M0 exposes no production database API. M1 must introduce a storage port whose
implementation owns `better-sqlite3`; other packages must not import the driver.

The compatibility contract is executable at:

```text
tests/contract/sqlite-driver.compat.test.ts
```

### 3. Contracts

- Runtime: Node 24 LTS.
- Driver: exact locked `better-sqlite3` line from ADR 0001.
- SQLite ledger: canonical identity, scope, lifecycle, revision, evidence,
  tombstone, release pointer, and receipt authority.
- FTS, relations, graph, vector, summaries, caches, and exports are derived.
- One serialized writer owns mutation.
- The synchronous driver runs inside a dedicated storage worker.
- Every mutation transaction writes the canonical effect, idempotency record,
  outbox jobs, and receipt atomically.
- Receipt persistence records principal/scope access in the same transaction;
  receipt lookup must fail closed unless every stored scope is authorized for
  the configured principal.
- JSON is for extensible metadata only; governed fields use typed columns.
- Data root must be a validated local path.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Actor/scope outside configured principal | Reject before storage |
| Reused idempotency key, same request hash | Return the durable receipt |
| Reused key, different request hash | Conflict |
| Expected revision is stale | Typed stale-revision conflict |
| Derived lane unavailable | Typed degraded result with named fallback |
| Restore behind tombstone/release frontier | Refuse serving until replayed forward |
| Purge leaves residual content | Incomplete purge; never mark complete |
| Unsupported/non-local path | Fail closed |

### 5. Good / Base / Bad Cases

- Good: a short transaction commits a revision, outbox job, idempotency row,
  and `MutationReceipt`.
- Base: a read transaction applies scope, lifecycle, validity, sensitivity,
  and tombstone filters before ranking.
- Bad: write SQLite from an MCP handler, then enqueue projection work after the
  transaction.

### 6. Tests Required

- Contract: driver supports WAL, FTS5, prepared statements, rollback, backup.
- Storage: constraints, transaction atomicity, idempotency, busy handling.
- Recovery: process crash, WAL/checkpoint, backup/restore, outbox replay.
- Governance: correction/revoke/purge across SQLite and every derived store.
- Privacy: zero cross-scope results and no content in diagnostics.

### 7. Wrong vs Correct

#### Wrong

```ts
import Database from "better-sqlite3";

// Imported from an MCP tool and executed on the protocol loop.
const database = new Database(path);
database.prepare("INSERT INTO events ...").run(payload);
```

#### Correct

```ts
// MCP depends on the storage port. The worker-owned adapter is the only driver
// consumer and returns a durable, typed receipt.
const receipt = await storage.commitEpisode(command);
```

## Scenario: External Managed Runtime Bootstrap

### 1. Scope / Trigger

Use these rules when an external client bootstrap must start or reuse Memory
Workbench before attaching one or more managed MCP stdio proxies.

### 2. Signatures

```ts
launchOrReuseWorkbench({
  config: memoryServerConfig,
  runtimeDirectory: stablePrivateDirectory,
  noOpen: true,
});

runMemoryMcpCli([
  "--config",
  mcpConfigPath,
  "--managed-descriptor",
  paths.runtimeDescriptorPath,
]);
```

### 3. Contracts

- The Workbench host remains the only SQLite writer; managed MCP processes are
  byte proxies and never fall back to direct mode.
- Every launcher environment for one root/config identity supplies the same
  absolute private `runtimeDirectory`. Do not derive an external bootstrap's
  directory from `tmpdir()` or `TMPDIR`, because sanitized MCP and interactive
  shell environments can resolve different locations.
- Root and full config identities must match before attach.
- Stale writer recovery uses `recoverStaleRootLease` only with the exact root,
  lease ID, fence token, observed heartbeat, expiry, and dead-owner proof.
- Concurrent launchers rely on the existing per-root launch arbitration and
  never delete descriptor, socket, credential, or writer-lock artifacts.
- Bootstrap diagnostics are content-free stderr events. Stdout is reserved for
  MCP bytes.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Same root/config from different `TMPDIR` values | Reuse one stable endpoint and writer |
| Config or root identity mismatch | Fail closed before proxy attach |
| Live, unexpired, malformed, or changed lease | Refuse stale takeover |
| Exact expired lease with dead PID owner | Recover through `recoverStaleRootLease` |
| Host unavailable after launch | Managed MCP remains blocked; no direct fallback |
| Multiple proxies start together | One host owner; every healthy proxy attaches by IPC |

### 5. Good / Base / Bad Cases

- Good: a stable private runtime directory, exact identity checks, one managed
  host, and multiple IPC proxies.
- Base: an existing healthy host is authenticated and reused without changing
  its writer lease.
- Bad: two environment-derived temp directories create one ready host and one
  health-only host for the same SQLite root.

### 6. Tests Required

- Start with no host and assert one ready endpoint plus managed MCP tools.
- Reuse from launch environments with and without `TMPDIR`; assert the same
  endpoint process ID and descriptor.
- Start two proxies under one bootstrap parent; assert one Runtime owner.
- Cover exact stale recovery and root/lease/fence/heartbeat/time/live-owner
  refusal.
- Search a pre-bootstrap evidence marker through the managed proxy after cold
  start and recovery.

### 7. Wrong vs Correct

#### Wrong

```ts
const runtimeDirectory = join(realpathSync(tmpdir()), `memo-graph-${uid}`);
// A sanitized MCP process and an interactive shell can now select two hosts.
```

#### Correct

```ts
const runtimeDirectory = "/absolute/private/stable/memo-graph-runtime";
await launchOrReuseWorkbench({ config, runtimeDirectory, noOpen: true });
```

## Scenario: Portable Codex Runtime Deployment

### 1. Scope / Trigger

Use this contract when packaging, installing, upgrading, or registering the
managed Runtime for Codex outside a workspace checkout.

### 2. Signatures

```text
pnpm codex:install -- [--data-root ABSOLUTE_PATH]
  [--mcp-config ABSOLUTE_PATH]
  [--operator-config ABSOLUTE_PATH]
  [--recovery-authority-root ABSOLUTE_PATH]
  [--runtime-dir ABSOLUTE_PATH]
  [--node ABSOLUTE_PATH]
  [--codex-bin ABSOLUTE_PATH]
```

Package deployment uses `pnpm --filter @memo-graph/codex-bootstrap deploy
--prod --legacy STAGING_DIRECTORY`. `@memo-graph/storage-sqlite` must publish
both `dist/` and its generated package-local `migrations/` directory.

### 3. Contracts

- Node major version is exactly 24; every override is absolute.
- Installer-controlled leaves remain dedicated: `data`, `codex-bootstrap`,
  `recovery-authority`, `workbench-runtime`, `mcp.json`, and `operator.json`.
  Reject filesystem/home roots, symlinked ancestors, and overlapping data,
  install, recovery, runtime, or configuration paths before any chmod/write.
- Refuse to run the installer as root; memo-graph is a current-user local
  Runtime, and privileged installation would expand pathname race impact.
- Clean installation creates mode `0600` MCP/operator configuration and
  Ed25519 key files plus mode `0700` data, recovery, install, and runtime roots.
- Default MCP and operator documents resolve to the same complete
  `MemoryServerConfig` identity and include an external recovery authority.
- If both configuration files already exist, preserve them. If exactly one
  exists, return `PARTIAL_CONFIGURATION_PRESENT` without writing the other.
- Build copies canonical root migrations into
  `packages/storage-sqlite/migrations`; runtime resolves migrations relative to
  the installed package, never the repository root.
- Releases are content-addressed and immutable. The registered command names
  only the selected release, Node executable, private configs, and stable
  runtime directory.
- Remove pnpm-generated `.bin` launchers and `.modules.yaml` before hashing;
  they embed the random staging path and are not part of the runtime import
  graph.
- Save the previous Codex registration privately before switching. Run the
  final command through the official MCP client, require all core tools, and
  complete a read-only search before reporting success. On probe failure,
  identity-check and stop only a host whose `STARTED` diagnostic binds the same
  instance/root/config, then restore the previous registration.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Node is not major 24 | `UNSUPPORTED_NODE_VERSION` |
| Any override is relative | `INSTALL_PATH_NOT_ABSOLUTE` |
| Override is broad, overlapping, symlinked, or not a dedicated leaf | Reject before filesystem mutation |
| Only one configuration file exists | `PARTIAL_CONFIGURATION_PRESENT` |
| Default recovery root already exists without configs | `DEFAULT_RECOVERY_AUTHORITY_PRESENT` |
| Codex executable is unavailable | `CODEX_BINARY_NOT_FOUND` |
| Existing registration has filters, timeouts, disabled state, or HTTP transport | `PREVIOUS_REGISTRATION_NOT_ROUND_TRIPPABLE` before mutation |
| Deploy entry or packaged migrations are absent | Installation fails before registration |
| Registration command fails | Restore the prior registration when present |
| `tools/list` omits a core memory tool | `MCP_TOOL_REGISTRATION_INCOMPLETE`, then rollback |

### 5. Good / Base / Bad Cases

- Good: a clean XDG account runs one command, creates a governed recovery
  authority, cold-starts the deployed Runtime, and receives all tools.
- Base: an existing paired configuration is preserved and a new immutable
  release replaces only the Codex registration after verification.
- Bad: register `dist/cli.js` from a mutable worktree or resolve migrations as
  `../../../migrations` from an installed package.

### 6. Tests Required

- Unit-test XDG/default paths, matching default documents, absolute
  registration arguments, and the core tool assertion.
- Compare packaged migrations byte-for-byte with canonical root migrations.
- Deploy into a temporary directory, cold-start from a different working
  directory and empty data root, then assert `runtime_state=ready` and the full
  tool list through the official MCP client.
- Search deployed JavaScript and package metadata for workspace and username
  paths.
- Exercise installer rollback with a controlled Codex CLI double whenever the
  registration transaction changes.

### 7. Wrong vs Correct

#### Wrong

```toml
args = ["/checkout/packages/mcp-server/dist/cli.js", "--config", "..."]
```

The next branch switch or checkout deletion invalidates registration.

#### Correct

```toml
args = ["/xdg/data/memo-graph/codex-bootstrap/releases/release-HASH/dist/cli.js",
        "--mcp-config", "/xdg/config/memo-graph/mcp.json",
        "--operator-config", "/xdg/config/memo-graph/operator.json",
        "--runtime-dir", "/xdg/state/memo-graph/workbench-runtime"]
```

## Scenario: Deterministic L0 Evidence Ingestion

### 1. Scope / Trigger

Use this contract when `memory_evidence_ingest` accepts conversation turns,
tool results, or caller-supplied text-file bodies.

### 2. Contracts

- Decode the proposal envelope and bounded source batch through the shared
  strict schema before adaptation.
- The adapter is pure and may emit only one sealed `Episode`, ordered inline
  `EvidenceRecord[]`, and an empty blob list. It creates no candidate,
  governed revision, admission, learning release, or release-pointer effect.
- Map provenance without authority inflation: user turn to `user_stated`,
  assistant turn to `observed`, tool result to `tool_result`, and text import
  to `imported`. Reject any mapped authority or exact scope outside the local
  principal policy before storage.
- Secret plaintext and oversized UTF-8 batches fail before persistence.
- Both adapted ingestion and direct `memory_episode_commit` delegate to the
  same canonical commit helper and storage transaction.
- Same idempotency key plus identical artifacts replays the durable receipt;
  changed content, metadata, or order conflicts.

### 3. Tests Required

- Cover every supported source, deterministic identities, timestamp bounds,
  episode seal, strict fields, secret/size rejection, authority/scope denial,
  changed replay, and zero L1/learning publication side effects.
- Exercise ingest through official MCP stdio, close the process, reopen the
  same ledger, and prove searchable/explainable receipt lineage survives.

## Scenario: Versioned L1 Governance Transactions

### 1. Scope / Trigger

Use this contract when proposing an L1 candidate, reusing logical identity,
opening a conflict, or appending a successor revision.

### 2. Signatures

```ts
storage.admitMemory(command: AdmitMemoryCommand): Promise<GovernanceMutationResult>
storage.applyMemoryRevision(command: MemoryRevisionCommand): Promise<GovernanceMutationResult>
storage.governanceReplay(input: GovernanceReplayInput): Promise<GovernanceMutationResult | null>
```

Canonical rows are `memory_candidates`, `memory_objects`,
`memory_revisions`, evidence-link tables, `admission_decisions`,
`memory_conflict_groups`, append-only status events,
`governance_mutation_results`, idempotency rows, outbox jobs, and receipts.

### 3. Contracts

- Normalize a logical key through `normalizeLogicalKey`; derive its identity
  only through `logicalKeyHash`.
- The kernel computes admission from exact-scope persisted L0 evidence.
  Storage rechecks live lineage and prevents a decision above the safe maximum.
- Same idempotency key plus request hash replays the frozen result before new
  evidence, policy, or approval validation. A different hash is `CONFLICT`.
- Exact content reuses the current revision. Divergent content creates an open
  conflict and must not advance `current_revision_id`.
- A successor names the exact current revision. Candidate, revision,
  admission/status events, pointer CAS, epoch, outbox, result snapshot, and
  receipt commit in one guarded `BEGIN IMMEDIATE`.
- Prompt-injection signal detection has one shared implementation:
  `candidateHasPromptInjectionSignal`.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Missing, purged, foreign-principal, or foreign-scope evidence | `INVALID_INPUT`, zero candidate write |
| Secret content without encryption policy | `ENCRYPTION_REQUIRED` |
| Inferred or unconfirmed lineage | Candidate-only maximum |
| Sensitive, low-authority, or injection-like lineage | Quarantine maximum |
| Same normalized key and same content | Reuse identity/revision |
| Same normalized key and different content | Open conflict, pointer unchanged |
| Expected revision differs from current | `STALE_REVISION`, transaction rollback |
| Same idempotency key and changed canonical request | `CONFLICT` |

### 5. Good / Base / Bad Cases

- Good: one transaction appends a revision and admission, CASes one pointer,
  advances one epoch, and seals one replayable receipt.
- Base: a duplicate candidate records its own lineage while reusing the
  existing logical memory and immutable revision.
- Bad: update a revision row, perform a destructive upsert, or validate
  idempotency only after rereading mutable evidence/approval state.

### 6. Tests Required

- Admission integration asserts active, candidate-only, quarantine, and
  rejected-with-zero-write paths.
- Identity integration proves Unicode/case/whitespace normalization, exact
  duplicate reuse, and conflict without pointer change.
- CAS integration runs two successors from one expected revision and asserts
  one success plus one `STALE_REVISION`.
- Replay integration checks identical result/receipt after approval
  consumption and `CONFLICT` for changed content under the same key.
- Storage migration tests prove append-only triggers and restart-safe schema
  hashes.

### 7. Wrong vs Correct

#### Wrong

```ts
const evidence = await rereadEvidence();
await verifyApproval();
return storage.applyMemoryRevision(command); // replay is now state-dependent
```

#### Correct

```ts
const replay = await storage.governanceReplay({ idempotency_key, request_hash });
if (replay !== null) return replay;
// Only a new effect evaluates mutable evidence and authorization state.
return storage.applyMemoryRevision(command);
```

## Scenario: Versioned Secret Ciphertext and Key Lifecycle

### 1. Scope / Trigger

Use this contract whenever `secret` content, an encryption-key transition, a
nonce reservation, an encrypted external artifact, or a secret crypto-erasure
crosses the main-thread/worker/SQLite boundary. The U2 path is dark-launched:
normal admission remains `ENCRYPTION_REQUIRED` until the separately qualified
release-control and operator-authority flow is enabled.

### 2. Signatures

```ts
storage.inspectEncryptionKeys(): Promise<EncryptionKeyInventory>
storage.darkLaunchInstallEncryptionKey(input: {
  idempotency_key: string;
  key_id: string;
  key_generation: number;
  key_descriptor: number;
  authority_key_id: string;
  authority_descriptor: number;
  commitment_key_id: string;
  commitment_descriptor: number;
}): Promise<EncryptionReceipt>
storage.darkLaunchAdmitSecret(input: DarkLaunchAdmitSecretInput): Promise<EncryptionReceipt>
storage.darkLaunchBeginKeyRotation(input: DarkLaunchBeginKeyRotationInput): Promise<BeginKeyRotationResult>
storage.darkLaunchResumeKeyRotation(input: DarkLaunchResumeKeyRotationInput): Promise<KeyRotationProgress>
storage.darkLaunchPurgeSecret(input: DarkLaunchPurgeSecretInput): Promise<EncryptionReceipt>
```

The storage worker may receive key identities, public verification keys,
verification tags, signed authority envelopes, nonce reservations, AEAD
metadata, and ciphertext. It must never receive plaintext, private signing
keys, commitment keys, or encryption-key bytes.

### 3. Contracts

- Envelope v1 is AES-256-GCM with an exact 32-byte key, 12-byte nonce, 16-byte
  tag, and AAD bytes formed from the UTF-8
  `memo-graph/secret-envelope/v1` domain followed by canonical metadata JSON.
- Metadata binds key and generation, owner and generation, exact scope,
  sensitivity, content identity/class, media type, and an owner/scope-specific
  keyed plaintext commitment. The envelope also binds ciphertext hash, size,
  tag, and AAD hash.
- Encryption, authority-signing, and commitment keys are distinct. SQLite
  persists only key IDs, public verification keys, and keyed verification
  tags; raw or private key bytes remain in short-lived main-thread buffers
  loaded from already-opened, private, owner-checked regular descriptors.
- `SecretAdmissionApproval` and `SecretUseAuthority` are Ed25519-verified,
  purpose-bound, expiring, and single-use. Admission additionally binds the
  configured principal, current root fence, current key, request digest, and
  envelope AAD. Consumption commits in the same SQLite transaction as the
  authorized effect or its content-free receipt.
- Admission preflight and worker-transaction revalidation use an explicit
  schema-validated verification timestamp from the same runtime clock. Do not
  mix an injected preflight clock with worker-local `Date.now()`.
- `secret_nonce_reservations` persists the operation class/rotation identity,
  key generation, AAD hash, commitment, owner generation, and request digest.
  A retry may reuse a nonce only when every persisted binding is identical.
  A committed retry routes to the original `secret_admit` or
  `key_rotation_item` receipt; it cannot reinterpret the operation.
- Inline ciphertext is the default atomic representation. Ciphertext above
  the frozen threshold uses a registered `prepared -> committed -> retired`
  file saga. Startup reconciliation validates live references, removes
  unreferenced temp/final artifacts, and never promotes an orphan to a live
  owner.
- Rotation keeps the old key `current` while the new key is `rotating_to`.
  Secret writes quiesce; each decrypt requires one verified use authority.
  Abort is legal only before the first rewrite. Completion atomically retires
  the old key, promotes the new key, and seals the receipt. After a rewrite,
  recovery is roll-forward.
- Secret purge validates the complete authority and target before filesystem
  mutation, retires every owner reservation/artifact, removes affected
  backups, seals a content-free receipt, vacuums SQLite, then truncates WAL.
- Migration 0015 adds side tables without rewriting the 0014 canonical
  payload tables. Existing non-secret identities, counts, receipts, and
  frontiers remain unchanged. A pre-0015 live secret plaintext row makes the
  upgrade fail with `MIGRATION_DRIFT`.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Public admission without the qualified release path | `ENCRYPTION_REQUIRED`, zero enqueue/effect |
| Key descriptor is wrong owner/mode/type/size or changes during read | `KEY_PROVIDER_INVALID` |
| Missing, revoked, or ambiguous key state | `KEY_UNAVAILABLE`, `KEY_REVOKED`, or `KEY_STATE_AMBIGUOUS` |
| Forged, expired, replayed, wrong-principal/fence/purpose/scope authority | Typed rejection, zero canonical/file effect and zero new consumption |
| Same idempotency key with changed operation/rotation/key/AAD/commitment/owner/request | `NONCE_REUSE` or `CONFLICT`; reserved nonce is not re-encrypted |
| Rotation item response is lost after commit | Replay the original item receipt; do not decrypt or increment twice |
| External artifact exists without a live encrypted-content reference at startup | Remove/quarantine by registry rule; do not publish |
| Purge authority is invalid or rotation is active | Reject before deleting backups or ciphertext |
| Migration interruption before ledger commit | Entire 0015 DDL and migration-ledger row roll back |
| Historical live secret plaintext is detected during 0015 | `MIGRATION_DRIFT`; no automatic encryption/backfill |

### 5. Good / Base / Bad Cases

- Good: exact private descriptors, distinct key roles, verified authority,
  durable nonce reservation, ciphertext-only worker payload, and one atomic
  effect/receipt produce an idempotent encrypted owner.
- Base: no qualifying G6 `GO` control is installed. The repository's signed
  G6 `NO-GO` artifact is audit-only and never auto-discovered; ordinary
  non-secret reads/writes continue and secret admission stays
  `ENCRYPTION_REQUIRED`.
- Bad: a shape-valid authority with an unchecked signature, a nonce replay
  under another operation class, or backup deletion before authorization is a
  security/data-integrity defect even when happy-path tests are green.

### 6. Tests Required

- Contract known-answer tests assert exact AES-GCM parameters, canonical AAD,
  envelope/hash/size binding, legal key states, and strict G6 default-off
  controls.
- Storage tests assert descriptor checks, distinct key roles, nonce uniqueness,
  changed-input replay rejection, transactional approval consumption, and
  production `testOperations=false` denial.
- Recovery tests inject response loss and process exit at nonce, rotation,
  external prepare/file/reference, abort, revoke, purge, and migration
  boundaries; assert old-or-new state, exact receipt replay, and restart
  convergence.
- Security tests scan SQLite, WAL/SHM, blobs/temp/quarantine, backups,
  diagnostics, and receipts for plaintext and raw-key markers, and prove
  standard FTS/MCP/Context paths cannot serve secret content.

### 6.1 Recorded G6 boundary

G6 closed `NO-GO` on 2026-08-02 for the exact Darwin arm64/APFS local
candidate. Security, resource, encryption, privacy, supply-chain, and review
evidence passed, but direct per-fault integrity proofs and direct typed
Runbook automation evidence remained blocked. Therefore:

- `secret_admission_allowed` remains false;
- a shape-valid or correctly signed `NO-GO` control never qualifies ingress;
- graph/vector remain disabled and automatic learning publication remains
  disabled;
- reopening G6 requires a new candidate and evidence bundle rather than
  rewriting the immutable U7 reports.

### 7. Wrong vs Correct

#### Wrong

```ts
SecretUseAuthoritySchema.parse(authority); // shape/hash only
removeAffectedBackups(owner);              // filesystem effect first
return storage.purgeEncryptedSecret(authority);
```

#### Correct

```ts
verifyEd25519(authority.authority_key_id, authority.signature, authority.authority_hash);
await storage.preflightSecretPurge({ authority, principal_id, root_fence });
// The worker rechecks and consumes authority with the durable purge receipt.
return storage.purgeEncryptedSecret({ authority, request_digest });
```

## Scenario: Tombstone-First Purge Saga

### 1. Scope / Trigger

Use this contract for `memory_delete`, purge retries, physical payload
redaction, and any derived store that can retain governed memory content.

### 2. Signatures

```ts
storage.memoryDeleteReplay(input: GovernanceReplayInput): Promise<MemoryDeleteResult | null>
storage.deleteMemory(command: MemoryDeleteCommand): Promise<MemoryDeleteResult>
storage.runPurge(input: PurgeRunInput): Promise<PurgeReceipt>
```

### 3. Contracts

- An effect-bearing delete consumes its exact trusted approval in the same
  transaction that advances `tombstone_epoch`, clears the current pointer,
  disables Context eligibility, appends a tombstone event, creates the purge
  job, advances the ledger epoch, and seals the mutation receipt.
- Idempotency replay precedes approval lookup. A dry run returns a sealed,
  content-free preview receipt but does not persist receipt, idempotency, or
  result rows, mutate the tombstone frontier, or consume approval.
- Online reads hard-filter tombstoned objects and purged L0 evidence before
  asynchronous cleanup begins.
- The purge job checks exactly these stores: revisions/evidence, candidates,
  conflicts, FTS, Context, exports/caches, blobs, backups, and projection
  consumers.
- Exclusive canonical payloads use a job-scoped redaction guard. Ordinary
  updates remain append-only; Context JSON is re-sealed with a new valid
  `frozen_hash`.
- Shared live evidence/blob references are residual debt. Completion requires
  every store outcome to be `verified` and the combined residual set to be
  empty.
- A completed purge receipt is replayed without another attempt. Partial and
  failed jobs retain their original purge identity and are retryable after
  restart.
- FTS drain and rebuild sources exclude `purged_at` evidence, and completed
  purge compacts SQLite/WAL so deleted exclusive plaintext cannot reappear.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Delete replay with the same request hash | Frozen result, no approval recheck |
| Delete replay with a different request hash | `CONFLICT` |
| Effect without a trusted unused approval | `APPROVAL_REQUIRED` or `APPROVAL_INVALID` |
| Stale expected revision | `STALE_REVISION`, zero tombstone write |
| Shared live lineage | Partial receipt with named residual hashes |
| Store failure | Failed receipt with store-local error outcome |
| Retry after restart | Same purge job, incremented attempt |
| Retry after completion | Exact latest completed receipt |

### 5. Tests Required

- Exclusive deletion proves immediate ineligibility, nine verified outcomes,
  zero residual, restart safety, and no FTS rebuild resurrection.
- Shared-lineage deletion proves partial debt and later completion after the
  final live reference is tombstoned.
- Recovery proves retry and completed-receipt replay while the redaction guard
  is empty afterward.
- Security scans the isolated data root for deleted plaintext and proves direct
  append-only rewrites still fail outside the purge guard.

## Scenario: Verified Restore Frontier

### 1. Scope / Trigger

Use this contract whenever creating or verifying a complete backup, or
publishing that backup into a new data root. Production operator restore
remains disabled until the U5 qualification gate records fault, scale,
resource, and runbook evidence.

### 2. Signatures

```ts
storage.createBackup(): Promise<BackupResult>
verifyCompleteBackupBundle({
  directory,
  expectedManifest?,
}): CompleteBackupManifest

restoreBackupToEmptyDataRoot({
  backup,
  dataRoot,
  recoveryHeadProvider,
  requiredKeyDescriptors,
}): Promise<RestoreBackupResult>
```

### 3. Contracts

- A complete manifest binds the canonical database logical hash, every
  database-owned blob and external artifact, the immutable migration chain,
  root/principal identity, configuration and environment identities, all
  governed frontiers, and required key IDs/generations. It does not contain
  the external recovery anchor.
- `BackupResult` carries both the manifest and signed external recovery
  anchor; the anchor's `backup_manifest_hash` binds the two. The head is
  authoritative state outside the snapshot. Restore must prove it is the
  provider's current head, matches the trusted key and manifest, and has no
  unresolved pending/committed reservation. Bundle verification alone does
  not establish external recovery authority.
- The restored database checkpoint, external head, manifest minimums, and
  recomputed state commitment must agree exactly. A snapshot behind any
  tombstone, purge, projection, Context, learning, release-control, or
  encryption frontier is not ready to serve.
- Key metadata is inventory only: manifests and restore inputs contain key IDs
  and generations, never key bytes. Required key descriptors are verified
  before staging; absent, mismatched, or unexpectedly live key metadata fails
  closed.
- Restore never overwrites an existing target. It copies into a private
  sibling staging root, fsyncs a publication-intent marker, and uses an
  atomic no-replace publication. Only the exact matching final marker may
  reconcile response loss.
- Opening staging applies and verifies the immutable migration chain through
  the ordinary storage boundary.
- Publication requires SQLite `integrity_check`, zero foreign-key violations,
  verified content-addressed blobs, canonical memory/redaction invariants,
  valid Context item/frozen hashes, valid receipt hashes, and honest purge
  outcomes.
- FTS is derived and is verified by its logical source/frontier identity, not
  by copying or trusting SQLite FTS bytes. Graph and vector state are restored
  as explicitly unavailable/degraded and require rebuild before readiness.
- Pending, running, or failed purge jobs make a snapshot unpublishable.
  A partial job is allowed only when its latest valid receipt names non-empty
  residual hashes and no store failed. The tombstone remains authoritative.
- Any failure closes the worker and removes staging; the requested target must
  remain absent.

### 4. Data / State Boundaries

- Backup bytes and the manifest are untrusted input until every manifest,
  artifact, database fact, signature, and key descriptor is verified.
- Private recovery keys and provider state live outside both the data root and
  backup tree. The SQLite ledger stores only the reconciled recovery
  checkpoint/effect records needed to prove agreement.
- Publication intent is crash-recovery state inside staging. The final marker
  is the only evidence that the exact target was published; neither marker
  weakens the external-head or database-checkpoint checks.
- Restore produces a blocked/degraded readiness state for derived lanes.
  Operator enablement, remote restore, and automated disaster-recovery
  orchestration remain U5-disabled.

### 5. Error / Recovery Matrix

| Condition | Required result |
| --- | --- |
| Missing/extra manifest file, artifact, or binding | `CORRUPTION`, no staging publication |
| Migration set differs from the immutable chain | `MIGRATION_DRIFT`, no staging publication |
| External head/key/signature differs from manifest | `RECOVERY_AUTHORITY_INVALID` or `STALE_RECOVERY_HEAD` |
| Provider has unresolved pending/committed work | Refuse backup/restore readiness |
| Database checkpoint or governed frontier differs | Fail closed before publication |
| Required key metadata is absent or generation differs | `KEY_UNAVAILABLE` |
| Target exists, is a symlink, or races into existence | No-replace failure; never overwrite |
| Failure before publication | Remove staging; target remains absent |
| Crash after publication with exact final marker | Reconcile and return the prior publication |
| Intent exists without exact final marker | Do not claim publication |
| FTS/graph/vector bytes are absent or stale | Rebuild/degrade from canonical logical state; never trust bytes |

### 6. Tests Required

- A current L0 snapshot restores at frontier zero.
- Contract tests omit each required manifest binding and artifact descriptor.
- A pre-delete snapshot fails behind the external tombstone/purge head.
- A post-tombstone snapshot without a terminal purge outcome fails with
  `INCOMPLETE_PURGE`.
- A current snapshot with honestly named backup debt restores, while corrupt
  backup evidence fails before target publication.
- Fault injection covers every copy, verification, close, fsync, intent,
  no-replace publication, final-marker, and response-loss boundary.
- Filesystem tests cover existing, symlink, dangling-symlink, and racing
  targets; no run may replace another publisher's directory.
- Recovery tests cover absent/mismatched keys, provider mismatch, unresolved
  reservations, checkpoint disagreement, and exact response-loss replay.
- Readiness tests prove logical FTS validation and explicit graph/vector
  degradation; no production operator path is enabled before U5.

### 7. Forbidden Patterns

- Do not accept a caller-supplied minimum frontier as recovery authority.
- Do not verify only the manifest JSON while ignoring missing or extra files.
- Do not place private/public recovery-key files or provider state inside the
  data root or backup tree.
- Do not copy or hash raw FTS index bytes as canonical recovery truth.
- Do not publish with overwrite-capable rename, check-then-rename, or a
  symlink-following target path.
- Do not infer success from an intent marker, a directory name, or an observed
  target without the exact final marker and external/database agreement.
- Do not expose production restore/operator automation before U5 explicitly
  releases it.

## Scenario: External Recovery Anchor and Replay Registry

### 1. Scope / Trigger

Use this contract for every recovery-protected canonical, control, purge,
projection, Context, learning, key, or release-control effect.

### 2. Contracts

- The external provider persists one signed reservation per
  `idempotency_key`. Pending and committed entries are unresolved; reconciled
  entries remain as a terminal replay registry and do not block startup or
  backup.
- A same-key, same-request replay reuses the terminal `pending_id`, verifies
  the matching append-only SQLite `recovery_anchored_effect`, returns the
  original durable operation result, and does not advance the external head
  generation or insert another recovery effect.
- Recovery result commitments omit only the request-local `replayed` delivery
  flag. Receipt hashes, outcomes, state, `committed`, and every other durable
  result field remain bound and any change fails closed.
- A same idempotency key with a different operation or request hash conflicts.
  Duplicate pending IDs or idempotency keys make provider state invalid.
- Late replay after unrelated newer effects is legal only when the current
  checkpoint matches the current storage commitment and the replay leaves
  that complete recovery state byte-for-byte unchanged.
- A retryable saga step whose result legitimately evolves under one business
  identifier uses a fresh recovery reservation per invocation; the business
  repository still enforces its own operation/idempotency transition.
- The terminal registry is append-only recovery authority, not an unresolved
  work queue. U5 resource evidence must measure it and define a compaction
  gate before any pruning; pruning must retain an equivalent authenticated
  idempotency binding for every live SQLite recovery effect.

### 3. Tests Required

- Response loss and ordinary replay each produce one business receipt, one
  recovery effect, and one external-head advance.
- Request A, then request B, then replay A returns A's original result without
  changing the current head or recovery-effect count.
- Provider state rejects mismatched key pairs, duplicate idempotency bindings,
  forged terminal records, and a terminal record without its SQLite effect.
- Result-commitment tests prove `replayed` may differ while changing any
  durable field, including `committed`, remains invalid.

## Scenario: Canonical Eligibility and Governed L1 FTS

### 1. Scope / Trigger

Use this contract for every model-visible L1 read, including search, get,
explain, and Context compilation, and whenever a projection proposes an L1
candidate.

### 2. Signatures

```ts
storage.checkMemoryEligibility(input: MemoryEligibilityInput): Promise<MemoryEligibilityResult>
storage.getGovernedMemory(input: GovernedMemoryLookupInput): Promise<GovernedMemoryLookupResult>
storage.searchGovernedMemory(input: GovernedMemorySearchQuery): Promise<GovernedMemorySearchResult>
```

### 3. Contracts

- SQLite `memory_objects.current_revision_id` is the canonical current pointer.
- Projection rows identify candidates only. Every FTS hit is revalidated
  against principal, exact scope, object/revision lifecycle, current pointer,
  live evidence, activation, validity, conflict, usage, and sensitivity.
- A successor changes the canonical pointer synchronously. FTS
  upsert/delete/invalidate jobs may lag without making the predecessor usable.
- Canonical inline search supplements pending FTS work so a committed
  successor has read-your-write visibility.
- L1 Context items retain exact revision, evidence lineage, transform, and
  validity metadata. Excluded L1 items contribute only identity and reason
  codes to the retrieval receipt.
- Historical Context remains immutable, but exact replay revalidates every L1
  item against current canonical eligibility. A corrected, demoted, blocked,
  revoked, expired, or otherwise ineligible item fails with `CONFLICT`; an
  unredacted tombstoned item fails with `INCOMPLETE_PURGE`. Only a purge-redacted
  item with valid item and frozen hashes may replay as `[PURGED]`.
- Rebuild `memory_fts` only from current active, context-eligible, inline
  revisions. The projection never decides eligibility.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Candidate or working lifecycle | `CANDIDATE_ONLY` |
| Pointer mismatch or superseded lifecycle | `SUPERSEDED` |
| Quarantined, revoked, or purged object | `QUARANTINED`, `REVOKED`, or `TOMBSTONED` |
| Outside validity window | `NOT_YET_VALID` or `EXPIRED` |
| Open logical-key conflict | `OPEN_CONFLICT` |
| Latest applicable usage rule blocks | `USAGE_BLOCKED` |
| Missing activation or exact-scope live lineage | `NO_ACTIVATION` or `NO_LIVE_EVIDENCE` |
| Sensitive/secret content is not authorized | `SENSITIVE_EXCLUDED` or `SECRET_EXCLUDED` |

### 5. Good / Base / Bad Cases

- Good: rank an FTS hit, revalidate it canonically, then compile the exact
  eligible revision into a frozen Context.
- Base: while FTS cleanup is pending, canonical fallback returns the successor
  and rejects a stale predecessor hit.
- Bad: treat membership in `memory_fts`, graph, or vector results as permission
  to place content in Context.

### 6. Tests Required

- Correction tests prove no predecessor resurrection before outbox drain.
- Eligibility tests cover every invalid lifecycle, validity, conflict, usage,
  scope, lineage, and sensitivity reason.
- FTS tests cover upsert, delete, invalidation, restart, and rebuild.
- Context tests preserve hard budgets, L0 fallback, L1 lineage, exclusion
  receipts, and immutable historical Context artifacts.
- Replay tests prove immutable artifacts do not bypass later canonical
  correction, usage, revoke, tombstone, or purge state.

### 7. Wrong vs Correct

#### Wrong

```ts
const hit = memoryFts.search(query)[0];
return hit.content; // A stale projection row is not an authorization result.
```

#### Correct

```ts
const hit = memoryFts.search(query)[0];
const result = await storage.checkMemoryEligibility(hit);
if (!result.eligible) return result.reason_code;
return result.item;
```

## Scenario: Trusted Approval and User-Control Transactions

### 1. Scope / Trigger

Use this contract for correction, pin, demote, Context usage allow/block,
revoke, delete, or any future important/destructive memory mutation.

### 2. Signatures

```ts
approvalRegistry.verify(binding: ApprovalBinding): Promise<VerifiedApproval>
approvalRegistry.confirmUnchanged(approval: VerifiedApproval): Promise<void>
storage.memoryControlReplay(input: GovernanceReplayInput): Promise<MemoryControlResult | null>
storage.applyMemoryControl(command: MemoryControlCommand): Promise<MemoryControlResult>
```

The public request carries only `approval_id`. The verified grant and registry
digest are internal runtime-to-storage artifacts.

### 3. Contracts

- Authorize principal, authority, scope, safety class, and destructive
  enablement before reading the approval registry.
- Replay a committed same-hash idempotency record before requiring a live
  approval. A changed hash is `CONFLICT`.
- Bind approval exactly to principal, tool, safety class, complete scope set,
  canonical public-request hash, and an unexpired validity window.
- Read a local manifest only from an absolute, regular, non-symlink path owned
  by the expected user and not group/world writable. Validate the strict
  manifest schema, each canonical grant digest, and a whole-registry digest.
- Recheck the whole-registry digest immediately before storage. Storage
  revalidates the grant and consumes its identifier in the same
  `BEGIN IMMEDIATE` transaction as the canonical effect and receipt.
- Effect-bearing approvals are single-use across idempotency keys.
- Dry-run carries no approval authority, changes no canonical pointer,
  lifecycle, control state, epoch, projection, receipt, idempotency, or result
  row, and returns an ephemeral content-free receipt with `DRY_RUN`.
- Pin changes retention preference only. It cannot upgrade authority, extend
  validity, resolve conflict, or override usage/revoke filters.
- Usage rules may be global or exact-Context scoped. An applicable scoped rule
  takes precedence over the global rule; the newest rule at that specificity
  wins.
- Demote returns an active memory to candidate state. Revoke immediately
  hard-filters it. Delete remains disabled by default and is completed only by
  the tombstone/Purge Saga contract.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Missing approval for a new effect | `APPROVAL_REQUIRED`, zero mutation |
| Expired, forged, changed, reused, wrong-principal/scope/tool/hash grant | `APPROVAL_INVALID`, transaction rollback |
| Same idempotency key and request hash after approval consumption | Replay durable effect and receipt |
| Same idempotency key with changed request | `CONFLICT` before approval lookup |
| Dry-run with no approval | Ephemeral preview receipt, no durable row, unchanged canonical epoch/state |
| Delete while destructive tools are disabled | `PERMISSION_DENIED` before approval lookup |
| Pin on expired/revoked/conflicted memory | Pin may persist; eligibility remains excluded |
| Scoped allow over global block | Allowed only in that exact Context scope |

### 5. Good / Base / Bad Cases

- Good: verify an exact grant, confirm the manifest snapshot, then atomically
  mutate, consume the approval, advance the epoch, enqueue invalidation, and
  seal the receipt.
- Base: return a committed same-hash replay even when the approval manifest no
  longer contains the consumed grant.
- Bad: accept an approval object from tool input, consume approval before the
  effect transaction, or treat pin as an eligibility bypass.

### 6. Tests Required

- Security tests cover missing, expired, forged, changed, reused,
  wrong-principal, wrong-scope, wrong-tool, and wrong-hash approvals.
- Filesystem tests cover relative paths, symlinks, ownership mismatch, and
  group/world-writable manifests.
- Mutation tests prove approval consumption rolls back with failed effects and
  that same-hash replay does not reverify approval.
- Dry-run tests compare epoch, current revision, candidates/revisions, control
  events, approvals, and projection jobs before and after.
- Direct-runtime and MCP calls over the same request produce the same governed
  result.
- User-control tests keep pin, global/scoped usage, demote, revoke, and delete
  observably distinct.

### 7. Wrong vs Correct

#### Wrong

```ts
const approved = input.approved === true;
await approvals.consume(input.approval_id);
return storage.pin(input.memory_id);
```

#### Correct

```ts
const replay = await storage.memoryControlReplay({
  idempotency_key,
  request_hash,
});
if (replay !== null) return replay;

const verified = await approvalRegistry.verify(binding);
await approvalRegistry.confirmUnchanged(verified);
return storage.applyMemoryControl({ request, approval: verified });
```

## Scenario: Bounded Layered Projection Recall

### 1. Scope / Trigger

Use this contract before enabling any L2/L3 lane that searches projection
content, revalidates projection lineage, traverses relations, or combines more
than one exact scope into a Context.

G3 remains HOLD until every rule in this section is executable.

### 2. Signatures

```ts
storage.searchProjections(
  query: ProjectionSearchQuery,
): Promise<ProjectionSearchResult>

storage.getProjectionSourcesByRevisionIds(
  query: ProjectionSourceBatchQuery,
): Promise<ProjectionSourceBatchResult>

compileLayeredContext({
  scope_frontiers,
  candidates,
  telemetry,
}: MultiScopeLayeredContextInput): CompileContextResult
```

`ProjectionSearchResult` carries a cursor or an explicit
`candidate_space_truncated` flag. `ProjectionSourceBatchResult` returns one
typed result for every requested source revision, including a stable exclusion
reason for missing or ineligible sources. Multi-scope Context records one
frontier per exact scope and seals their canonical ordered aggregate.

### 3. Contracts

- Apply relevance filtering in storage before the requested candidate limit,
  or paginate until the bounded search policy proves no eligible match was
  skipped.
- Candidate limits bound returned candidates; they must not silently redefine
  the searchable corpus.
- Revalidate the exact source revision IDs referenced by returned projections.
  Never enumerate an arbitrary prefix of the scope and compare that partial
  set with a full-scope frontier hash.
- A scope frontier is keyed by principal plus exact scope. Never apply one
  scope's source/projection hash to another scope's candidates.
- Relation start-set caps set `truncated = true` and record a stable reason
  code before discarding any start revision.
- Any incomplete candidate space, source batch, or scope frontier is named
  `DEGRADED` or fails closed; it cannot become `NO_MATCH`.
- Exact replay revalidates every included projection against its own recorded
  scope frontier and the current canonical source revisions.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Relevant projection exists after the first storage page | Return it or report explicit bounded truncation; never `NO_MATCH` |
| Projection references a source outside the first 1,000 scope rows | Batch-load and revalidate that exact revision |
| Requested source batch is incomplete | Exclude the projection with a stable source reason |
| Request contains two scopes with different projection frontiers | Freeze and validate both scope frontiers |
| Relation start set exceeds the configured cap | `DEGRADED` plus `RELATION_START_TRUNCATED` |
| Projection search/index is unavailable | Named degraded lane with safe `recent_l1` fallback |

### 5. Good / Base / Bad Cases

- Good: search returns 20 relevant candidates from 6,000 projections, then
  batch-revalidates only their exact lineage and seals both requested scope
  frontiers.
- Base: no projection matches after the bounded storage search proves the full
  searchable set was covered; return `NO_MATCH`.
- Bad: query 21 rows, filter them in memory, and claim no match while a
  relevant row exists later.
- Bad: hash the first 1,000 active L1 rows and compare it with a frontier built
  from 25,000 rows.
- Bad: choose the first projection's frontier for every scope in the request.

### 6. Tests Required

- Storage search: the only relevant row appears after the first unfiltered
  page and is still returned.
- Scale: more than 1,000 active L1 sources with a returned projection whose
  lineage crosses that prefix.
- Multi-scope: two exact scopes with different source/projection hashes both
  contribute eligible items and replay independently.
- Degradation: an incomplete source batch, projection index failure, and
  relation start-set truncation are named and never collapse to `NO_MATCH`.
- Recovery/purge: correction or tombstone in either scope excludes only its
  affected descendants and cannot be bypassed by a frozen aggregate frontier.
- Performance: Small and Expected evidence includes end-to-end storage search,
  exact-source revalidation, compiler latency, and token adherence.

### 7. Wrong vs Correct

#### Wrong

```ts
const rows = await storage.queryProjections({ limit: requestedLimit + 1 });
const matched = rows.filter((row) => matchesQuery(row, query));
```

#### Correct

```ts
const found = await storage.searchProjections({
  query,
  limit: requestedLimit,
  cursor,
});
const sources = await storage.getProjectionSourcesByRevisionIds({
  revision_ids: exactLineageIds(found.items),
});
return compileLayeredContext({
  scope_frontiers: found.scope_frontiers,
  candidates: revalidate(found.items, sources),
  telemetry: found.telemetry,
});
```

## Migrations

Migrations begin in M1, are forward-only, and are versioned files under
`migrations/`. Schema changes require a recovery/restore test and cannot move a
database behind its deletion or release frontier.

## Scenario: Governed Learning Canary Terminal Transaction

### 1. Scope / Trigger

Use this contract when moving a release-capable learning candidate from
`approved_for_canary` into a bounded terminal canary run.

### 2. Contracts

- Replay the normalized canary request before reading mutable candidate,
  control, fixture, or approval state.
- A canary authorization is an exact `learning_canary` /
  `important_mutation` artifact bound to principal, complete scope set,
  candidate, release slot/base, passed non-invalidated evaluation receipt,
  sealed manifest, three case hashes, request hash, control epoch, deadline,
  and expiry.
- Canary authorization is distinct from the post-canary release or rollback
  approval. The latter cannot exist until the terminal canary receipt exists.
- One immediate transaction appends the `approved_for_canary -> canary`
  transition, consumes the canary authorization, stores the terminal run,
  stores its receipt, and commits the idempotency result.
- The transition evidence set names both the passed evaluation receipt and the
  terminal canary receipt. A passing run has exactly three one-time exposures.
- A pause observed before canary start rejects the run. If pause commits after
  the run started, storage may accept only a non-passing `frozen` or `aborted`
  terminal run at the immediately following control epoch, with
  `LEARNING_PAUSED` and `started_at <= changed_at <= receipt.created_at`.
- Canary success, failure, pause, timeout, and crash recovery never move the
  normal active release pointer.

### 3. Tests Required

- Reject wrong tool/safety/principal/scope/candidate/slot/base/evaluation/
  manifest/request/control/time authorization bindings.
- Prove early fixture visibility is denied and every passing case is exposed
  exactly once.
- Persist drift, timeout, execution failure, and in-flight pause as bounded
  terminal evidence without pointer movement.
- Inject failure after guard, transition, authorization, run, receipt, and
  idempotency writes and verify the entire canary transaction rolls back.

## Scenario: Governed Learning Control Frontier CAS

### 1. Scope / Trigger

Use this contract when pausing or resuming the learning runtime and when a
release or rollback races a control transition.

### 2. Contracts

- The request's `expected_frontier_hash` names the aggregate learning
  frontier over every current control row and release pointer.
- A control row's `frontier_hash` names the content-free candidate,
  evaluation, canary, release, runtime, configuration, and corpus snapshot
  captured by that control transition.
- These hashes are different identities. Validate the aggregate hash against
  a freshly recomputed aggregate frontier, then compare-and-swap the control
  row using its stored row hash plus the expected control epoch.
- One immediate transaction writes the new control row, control receipt,
  approval consumption, idempotency result, and ledger epoch.
- Pause and resume each advance exactly one control epoch. Resume requires the
  exact paused runtime/configuration/corpus identity unless the request
  explicitly abandons drifted in-flight work.
- Ordinary governed memory reads and writes do not consult learning pause.

### 3. Tests Required

- Persist pause, close/reopen storage, and resume from the exact aggregate
  frontier.
- Reject a stale aggregate frontier, stale epoch, changed idempotent request,
  or unchanged target status.
- Prove runtime/configuration/corpus drift conflicts unless explicit
  abandonment is approved.
- Race pause with release and prove one serialization order wins without a
  partial pointer/control effect.
- Keep search, get, Context compilation, episode commit, and an approved
  memory control available while learning is paused.

## Naming

Use plural snake_case tables, snake_case columns, explicit foreign keys, and
indexes named for table plus ordered columns. Final names are frozen by the
first migration and should not be inferred from TypeScript class names.

## Scenario: Confirmed Operator Repair and Purge Audit

### 1. Scope / Trigger

Use this contract for restore, purge retry, FTS/layered/SQLite-relation repair,
key rotation, learning rollback, operator-action recovery, and residual
artifact audit at the local operator boundary.

### 2. Signatures

```ts
executeConfirmedOperatorAction(input): Promise<ContentFreeOperatorResult>
storage.auditPurgeArtifacts(input): Promise<ArtifactPurgeAudit>
storage.prepareOperationalRepair(input): Promise<OperationalRepairResult>
storage.completeOperationalRepair(input): Promise<OperationalRepairResult>
```

The executable mutation surface is `operator execute --confirmation-ref ...`.
The ref resolves only through an owner-only config file to an exact grant.

### 3. Contracts

- Ed25519 confirmation binds purpose, algorithm, authority generation,
  principal, command, nonce, intent hash, TTL, state/config/key/frontier/
  recovery digests, and the complete effect-parameter digest.
- Confirmation consumption is globally atomic across operation IDs. A durable
  confirmation-ID binding permits an exact crash replay after expiry while
  still rechecking signature, trust, revocation, intent, and consumption
  identity; it never authorizes a new operation. Expiry may finish an already
  committed effect or reconcile exact external publication evidence, but it
  cannot start an effect from `authorized` or an unreconciled
  `effect_prepared` state.
- Validate every signed state binding before preparation and immediately
  before the first external effect. The external action ledger advances only
  through authorized, prepared, effect-committed, receipt-committed, and
  responded states and reconciles exact publication evidence after crashes.
- Purge audit covers the exact versioned store registry. At a nonzero
  tombstone epoch, every required store needs a same-epoch, internally hashed
  frontier; missing, stale, corrupt, or indebted frontiers block completion.
  Audit never fabricates or rewrites purge frontiers or historical receipts.
  A retry for an older purge epoch cannot regress the current global frontier;
  same-epoch updates remain bound to their originating purge job.
- Repair source is canonical SQLite only. FTS marks only FTS rebuilding;
  layered and SQLite-relation repair mark the layered lane rebuilding. Resume
  uses the exact append-only repair job and canonical frontier. Completed jobs
  persist their artifact/relation counts and ledger epoch so later canonical
  changes cannot alter replayed results. Salvage and quarantine never publish.
- Key rotation receives a purpose-scoped capability only after exact signed
  plan verification and durable confirmation binding. Direct production
  begin/resume primitives remain unavailable. The capability propagates a
  private authorization only to the exact whitelisted rotation worker
  operations; unrelated or direct dark-launch operations remain denied.
- Recovery authority, action ledger, grants, approval artifacts, and key files
  are private, owner-checked, symlink-safe, bounded, and external to live data,
  backup, and restore targets. Residual audit scans all registered classes by
  descriptor with before/after identity checks and emits no content or paths.
  Its file identities are per-audit keyed commitments, and file/key buffers
  are zeroed after use.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Expired confirmation with no durable consumption | Reject, zero effect |
| Exact consumed confirmation after crash | Reconcile/finish only its bound operation |
| Confirmation ID reused for another intent/operation | Conflict before effect |
| Signed state/config/key/frontier/parameter drift | Reject before preparation/effect |
| Purge frontier missing, stale, corrupt, or indebted | `blocked`/`retryable`; audit incomplete |
| Repair source is salvage/quarantine | Reject; no derived publication |
| Artifact path is missing, unreadable, symlinked, replaced, or oversized | Block the class and the audit |
| Operator lock owner may still be live | Fail closed; no lock/temp removal |

### 5. Good / Base / Bad Cases

- Good: one exact confirmation consumption, two fresh state validations, one
  effect, one content-free receipt, and exact replay reconciliation.
- Base: epoch-zero purge audit records an explicit no-tombstone genesis proof;
  graph/vector remain verified ineligible.
- Bad: accept any latest purge receipt, rebuild FTS for a layered repair,
  reuse a confirmation ID across operations, or publish from salvage.

### 6. Tests Required

- Fault every operator-action transition and the external-effect response
  window; prove exactly one effect across restart, including post-expiry close.
- Race operation and confirmation locks; prove global confirmation-ID
  consumption, owner-not-live stale recovery, and no live-temp deletion.
- Exercise encrypted CLI restore, purge retry, each repair kind, key rotation,
  and learning rollback through config-bound grants and authorities.
- Prove direct production key-rotation methods remain denied, the confirmed
  capability survives begin/restart/resume, and its authorization cannot
  authorize an unrelated worker operation.
- Prove missing/stale/corrupt purge frontiers block, while completed same-epoch
  zero-debt frontiers converge without rewriting historical evidence.
- Interrupt each repair kind after prepare, reopen, observe the named degraded
  lane, and resume deterministically from canonical state.
- Replace files/directories during residual scan and assert fail-closed,
  content-free output for every artifact class.

### 7. Wrong vs Correct

#### Wrong

```ts
if (operatorSaidYes) await mutate();
auditFrontier ??= { debt_count: 0 };
```

#### Correct

```ts
await executeConfirmedOperatorAction(exactSignedBindings);
if (!sameEpochVerifiedFrontier) return blockedAudit;
```
