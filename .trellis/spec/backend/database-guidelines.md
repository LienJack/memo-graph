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

## Migrations

Migrations begin in M1, are forward-only, and are versioned files under
`migrations/`. Schema changes require a recovery/restore test and cannot move a
database behind its deletion or release frontier.

## Naming

Use plural snake_case tables, snake_case columns, explicit foreign keys, and
indexes named for table plus ordered columns. Final names are frozen by the
first migration and should not be inferred from TypeScript class names.
