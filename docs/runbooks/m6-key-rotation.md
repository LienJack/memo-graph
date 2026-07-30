# M6 key rotation

Prerequisites: stop the runtime writer; verify current key inventory; open old
and new encryption, authority, and commitment keys as owner-only inherited
descriptors; prepare a signed `key_rotate` intent whose parameter digest binds
all key identities and descriptor material digests.

Inspect:

```bash
node apps/operator-cli/dist/cli.js key inspect \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js key rotate --dry-run \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js operator execute \
  --confirmation-ref rotate_key_generation_2 \
  --config /private/operator.json --format json
```

The public dry run remains disabled and fail-closed; it never carries mutation
authority.
The confirmation ref maps to an owner-only grant file; it does not replace the
separately signed intent and has no `--yes` bypass. Storage issues a
purpose-scoped capability only after Ed25519 verification and an append-only
confirmation binding. No direct production begin/resume primitive exists.

Stop on key identity/material mismatch, revoked authority, changed key state,
ambiguous rotation ID, or unavailable descriptor. Resume only the exact durable
rotation ID; never start a second rotation. Before the first rewrite, rollback
requires a separately governed abort; this CLI slice does not expose an abort
command. After a rewrite, recovery is roll-forward. After completion, retain
the old key until live-ciphertext count is zero and revocation is separately
authorized. Preserve key inventory, confirmation binding, encryption receipts,
and operator-action receipt as evidence.
