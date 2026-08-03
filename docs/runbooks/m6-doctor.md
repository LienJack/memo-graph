# M6 doctor

Prerequisites: stop the runtime writer, use an owner-only operator config, and
build `@memo-graph/operator-cli`. Doctor is read-only and never prints memory
content.

Run:

```bash
node apps/operator-cli/dist/cli.js doctor \
  --config /private/operator.json --format json
```

Expected output is an `OperationalStatus` with `readiness`, ordered component
states, one `status_digest`, and no filesystem paths. Exit `0` is ready, `2` is
inspectable degradation, and `3` requires operator action.

Stop if the result is `blocked`, the external recovery authority is unavailable,
or the config is rejected. Do not start repair from an ambiguous root. Doctor
has no rollback action. Preserve the JSON output and the private operator-action
ledger as the evidence paths.
