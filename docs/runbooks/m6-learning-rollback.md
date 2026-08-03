# M6 learning rollback

Prerequisites: stop release publication, identify the active and target release,
verify the monitor receipt, and obtain the existing release and operator
approvals. Ordinary memory access may remain available while learning is
paused.

Verify:

```bash
node apps/operator-cli/dist/cli.js rollback verify \
  --release-ref prior_release \
  --config /private/operator.json --format json
node apps/operator-cli/dist/cli.js operator execute \
  --confirmation-ref rollback_to_prior_release \
  --config /private/operator.json --format json
```

Expected output is `operator_action_required` with
`publication=confirmation_required` and a parameter digest. Actual rollback
uses the owner-only grant mapped by the confirmation ref. The grant carries
only the canonical rollback request; distinct config-pinned M5 authority and
approval artifacts are re-read before commit. The signed digest binds the
complete request and exact target release. There is no `--yes` bypass.

Stop if the monitor, candidate, release pointer, control epoch, approval,
configuration hash, or recovery/frontier digest changes. Never substitute a
different target after confirmation. Replay reconciles the exact learning
ledger idempotency record and creates one operator receipt. Rollback of a
rollback is a new governed release action, not a history edit. Preserve monitor,
rollback receipt, learning frontier, and operator-action receipt as evidence.
