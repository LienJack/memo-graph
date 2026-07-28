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
- Idempotency replay precedes approval lookup. A dry run records a content-free
  receipt but does not mutate the tombstone frontier or consume approval.
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

Use this contract whenever publishing a backup into a new data root.

### 2. Signatures

```ts
restoreBackupToEmptyDataRoot({
  backup,
  dataRoot,
  minimumTombstoneEpoch,
}): Promise<RestoreBackupResult>
```

### 3. Contracts

- `minimumTombstoneEpoch` is required trusted state from outside the snapshot.
  A backup below it fails before staging is created.
- Restore never overwrites an existing target. It copies into a private
  sibling staging root and publishes by atomic rename only after verification.
- Opening staging applies and verifies the immutable migration chain through
  the ordinary storage boundary.
- Publication requires SQLite `integrity_check`, zero foreign-key violations,
  verified content-addressed blobs, canonical memory/redaction invariants,
  valid Context item/frozen hashes, valid receipt hashes, and honest purge
  outcomes.
- Pending, running, or failed purge jobs make a snapshot unpublishable.
  A partial job is allowed only when its latest valid receipt names non-empty
  residual hashes and no store failed. The tombstone remains authoritative.
- Any failure closes the worker and removes staging; the requested target must
  remain absent.

### 4. Tests Required

- A current L0 snapshot restores at frontier zero.
- A pre-delete snapshot fails with `STALE_TOMBSTONE_FRONTIER`.
- A post-tombstone snapshot without a terminal purge outcome fails with
  `INCOMPLETE_PURGE`.
- A current snapshot with honestly named backup debt restores, while corrupt
  backup evidence fails before target publication.

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
  lifecycle, control state, epoch, or projection, and records a content-free
  receipt with `DRY_RUN`.
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
| Dry-run with no approval | Durable preview receipt, unchanged canonical epoch/state |
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

## Migrations

Migrations begin in M1, are forward-only, and are versioned files under
`migrations/`. Schema changes require a recovery/restore test and cannot move a
database behind its deletion or release frontier.

## Naming

Use plural snake_case tables, snake_case columns, explicit foreign keys, and
indexes named for table plus ordered columns. Final names are frozen by the
first migration and should not be inferred from TypeScript class names.
