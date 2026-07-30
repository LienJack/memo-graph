# M6 storage pressure

Prerequisites: stop nonessential producers and run doctor. Do not delete WAL,
SQLite, blob, ciphertext, quarantine, or backup files manually.

Run:

```bash
node apps/operator-cli/dist/cli.js doctor \
  --config /private/operator.json --format json
```

Expected observations name `available_bytes`, `wal_bytes`, checkpoint health,
queue depth/age, and a read-only reason without paths or content. A healthy
checkpoint plus recovery headroom clears hysteresis; a single improved sample
does not.

Stop writes when readiness is `read_only` or `blocked`. Checkpoint is the only
allowed pressure mutation. If checkpoint remains busy or free space stays below
the recovery threshold, keep the runtime stopped and add capacity. Rollback is
to retain the canonical root unchanged and disable producers. Preserve doctor
JSON and checkpoint counters as evidence.
