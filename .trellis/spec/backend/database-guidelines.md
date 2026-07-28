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

## Migrations

Migrations begin in M1, are forward-only, and are versioned files under
`migrations/`. Schema changes require a recovery/restore test and cannot move a
database behind its deletion or release frontier.

## Naming

Use plural snake_case tables, snake_case columns, explicit foreign keys, and
indexes named for table plus ordered columns. Final names are frozen by the
first migration and should not be inferred from TypeScript class names.
