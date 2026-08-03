# M6 purge audit and projection repair

Prerequisites: stop the writer and obtain the current tombstone epoch. Configure
all nine owner-only operational artifact roots and the forbidden-marker policy.
Purge retry and repair use signed intents; salvage quarantine is not a source.

Audit and dry-run repair:

```bash
node apps/operator-cli/dist/cli.js purge audit \
  --audit-id purge_audit_001 --tombstone-epoch 0 \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js rebuild --dry-run \
  --repair-kind fts \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js operator execute \
  --confirmation-ref retry_purge_job_001 \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js operator execute \
  --confirmation-ref rebuild_fts_001 \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js operator execute \
  --confirmation-ref rebuild_layered_projection_001 \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js operator execute \
  --confirmation-ref rebuild_sqlite_relations_001 \
  --config /private/operator.json --format json
```

Purge output contains the complete versioned registry and the nine-class
descriptor-based residual scan. Per-file identities are audit-scoped keyed
commitments, so repeated audits cannot be joined by stable path hashes.
`completed=false`, `retryable`, or `blocked` is not success. Repair output requires confirmation
and names `canonical_sqlite` as its only source. FTS, layered projection, and
SQLite relations have separate exact repair kinds.

Stop if any required artifact class is missing/unreadable, debt remains, the
prior purge receipt changes, or canonical/frontier/config/key binding changes.
Each confirmation ref maps to an owner-only grant file with an exact signed
intent; there is no `--yes` bypass. Retry purge reconciles the exact operator
operation. Resume interrupted repair from its append-only
`operational_repair_jobs` row; its request hash, result counts, ledger epoch,
and result hash must replay exactly. Rollback disables the derived lane; canonical
history and immutable purge receipts are never rewritten. Preserve audit,
repair job, projection rebuild receipt, and operator-action receipt as evidence.
