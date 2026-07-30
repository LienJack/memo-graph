# M6 backup and restore

Prerequisites: stop the source writer, verify the external recovery head, keep
required key descriptors open as private inherited descriptors, and select
backup/target aliases from the owner-only config. Salvage and quarantine
directories are never valid restore sources.

Inspect and produce the canonical bindings/digest required for a separately
signed intent:

```bash
node apps/operator-cli/dist/cli.js backup inspect \
  --backup-ref current_backup \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js restore --dry-run \
  --backup-ref current_backup --target-ref recovery_target \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js operator execute \
  --confirmation-ref restore_current_to_recovery \
  --config /private/operator.json --format json
```

Expected dry-run status is `operator_action_required` with
`publication=confirmation_required`, the manifest hash, and an intent digest.
The confirmation ref maps to an owner-only grant file in operator config. That
grant contains the exact restore intent, confirmation, backup/target aliases,
and inherited key-descriptor handles. There is no `--yes` bypass.

If a killed process leaves both exact locks, first prove the recorded PID is
not live (a reused or live PID fails closed), then run:

```bash
node apps/operator-cli/dist/cli.js operator recover-lock \
  --confirmation-ref restore_current_to_recovery --process-id 12345 \
  --config /private/operator.json --format json
```

Recovery removes only the grant-bound operation/confirmation locks and their
exact private temp files. Retry `operator execute` afterward.

Stop on stale recovery head, missing keys, an occupied non-matching target, a
manifest mismatch, or any state/config/key/frontier digest change. Before
publication, remove only the operation-owned staging directory. After
publication, reconcile the exact publication marker and operation ID; never
overwrite the target. Preserve the backup manifest, recovery-head journal, and
operator-action receipt as evidence.
