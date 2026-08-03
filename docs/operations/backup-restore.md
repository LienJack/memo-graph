# L0 Backup and Restore

M1A provides a verified offline restore into a new data root. It does not
overwrite an existing runtime.

## Create a snapshot

```ts
const backup = await storage.createBackup();
```

The storage worker:

1. uses the SQLite online backup API;
2. copies every referenced content-addressed blob;
3. verifies copied blob hashes and `fsync`s files/directories;
4. opens the SQLite copy read-only;
5. runs `integrity_check`;
6. compares migration history, ledger epoch, and latest receipt frontier;
7. records the manifest only after all checks pass.

The result names the snapshot directory, database path, blob hashes, epoch,
latest receipt hash, integrity result, and database size.

## Restore to an empty root

```ts
const restored = await restoreBackupToEmptyDataRoot({
  backup,
  dataRoot: "/absolute/new/memo-graph-data",
  minimumTombstoneEpoch: trustedFrontier.tombstone_epoch,
});
```

`minimumTombstoneEpoch` must come from trusted state outside the snapshot. A
backup below that frontier fails with `STALE_TOMBSTONE_FRONTIER` before any
staging root is created.

The target must not exist. Restore copies into a private staging root, opens it
through the ordinary migration/health boundary, runs SQLite integrity and
foreign-key checks, verifies every artifact hash, canonical eligibility,
Context hashes, receipts, and purge residual state, compares the receipt
frontier, closes/checkpoints it, and only then atomically renames the staging
root to the target.

If any step fails, the target is not published. The staging root is removed.

## Recovery boundaries

- Never restore over a live or non-empty root.
- Keep the original root until the restored root passes application-level
  recall checks.
- M1A proves L0 evidence, receipt, FTS-rebuild, and blob recovery.
- M2 enforces the trusted tombstone frontier and verifies purge debt before
  publication. Graph/vector and release-pointer frontiers remain later gates.
- A backup is local data and inherits the same permissions, encryption, export,
  and purge policy as the source.
