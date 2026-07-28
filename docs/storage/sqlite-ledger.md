# SQLite L0 Ledger

The M1A storage adapter is the canonical L0 evidence boundary. Callers use
`SqliteStorageClient`; only its dedicated worker imports `better-sqlite3` or
touches the ledger, blob, backup, checkpoint, migration, outbox, and FTS files.

## Local layout

```text
<data-root>/
├── ledger/
│   └── memory.db
├── blobs/
│   └── <sha256 digest>
└── backups/
    └── snapshot-<epoch>-<id>/
        ├── memory.db
        └── blobs/
```

The root must be an absolute, non-root, non-URL, non-symlink local path. Known
network filesystem types fail closed. Directories are `0700`; database, blob,
and backup files are `0600`.

The current compatibility evidence is Darwin arm64 only. A path passing the
runtime checks does not itself certify an untested operating system or
filesystem.

## Canonical commit

`commitEpisode` accepts `unknown` and runtime-decodes the existing
`Episode`/`EvidenceRecord` contracts. It verifies:

- strict sequence and episode membership;
- scope equality across an episode;
- canonical inline-content hashes;
- raw blob SHA-256, sizes, and artifact references;
- the episode seal;
- idempotency-key/request-hash consistency.

One `BEGIN IMMEDIATE` transaction writes evidence, episode membership, ledger
epoch, FTS outbox jobs, a sealed mutation receipt, and the idempotency mapping.
The response is sent only after commit. Canonical tables have UPDATE/DELETE
triggers; future corrections append evidence or governed tombstones.

Retry behavior is exact:

- same key and same semantic request returns the stored receipt;
- same key and different request returns `CONFLICT`;
- a worker exit after commit but before response returns `WORKER_CRASHED`, and
  retry returns the durable receipt without another effect.

## Worker and writer boundary

The client serializes mutation-class requests and publishes queue depth, oldest
age, and completion counts. The worker serializes all SQLite operations. A
blocking SQLite call can delay other storage requests but cannot block the
MCP/main-process event loop.

Busy/locked SQLite errors become retryable `STORAGE_UNAVAILABLE`. Errors and
diagnostics contain operation metadata, timing, queue state, schema/epoch, and
stable codes only. Inline content, blob bytes, and search queries are excluded.

## FTS5

FTS is a derived exact-scope lane. A canonical commit appends outbox jobs and
sets projection state to `pending`; it never treats a pending index as a
successful empty search.

Search results are:

- `OK` with exact-scope rows;
- `NO_MATCH` when a ready index has no row;
- `DEGRADED` with `FTS_PENDING`, `FTS_REBUILDING`, or `FTS_UNAVAILABLE`.

`rebuildFts` drops and recreates only the virtual table, rereads inline evidence
from SQLite, completes related outbox jobs, and leaves the canonical ledger
epoch unchanged.

## Migrations

Migrations are ordered files under `migrations/`. Their full file SHA-256 is
stored in `schema_migrations`. Missing, reordered, renamed, modified, or
downgraded histories return `MIGRATION_DRIFT` before serving storage.

The current schema:

- `0001-evidence-ledger.sql`
- `0002-fts-baseline.sql`

Any change to an applied file is corruption. A schema change requires a new
forward migration and recovery evidence.
