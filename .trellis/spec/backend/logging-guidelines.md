# Logging Guidelines

## Status

M0 defines the logging contract; the structured logger is implemented in a
later milestone.

## Structured fields

Permitted fields include:

- timestamp, level, component, operation;
- request/receipt/job identifiers;
- scope kind (not secret scope labels);
- lifecycle/error/reason codes;
- duration, counts, bytes, token estimates, queue depth;
- schema/compiler/projection/evaluation versions;
- content hashes only where the threat model permits.

## Never log

- memory/evidence/Context text;
- tool arguments or artifact bodies;
- secrets, credentials, tokens, encryption keys;
- full filesystem paths under the user's data root;
- temporary Runbook config, grant, backup, restore, or verification paths;
- unredacted actor labels, purpose, or reason strings;
- deleted plaintext or purge residual content.

## Levels

- `debug`: development-only identifiers, versions, timings, counts.
- `info`: durable lifecycle transitions and health summaries.
- `warn`: degraded fallback, retry, queue pressure, incomplete projection.
- `error`: request failure, invariant violation, recovery/purge failure.

## Receipt relationship

Logs are operational hints and may be sampled or deleted. Receipts are durable
replay evidence. A log entry must reference a receipt/job identifier instead of
duplicating receipt payloads.

## Required tests

- Inject marker secrets into memory, tool, error, and purge fixtures.
- Assert marker absence from every log sink and default diagnostic export.
- Assert required identifiers/codes remain present after redaction.
- Direct G6 Runbook evidence may retain only step IDs, exit/state classes,
  booleans, counts, canonical command identities, and source bindings; never
  captured stdout/stderr or fixture paths.

## Wrong vs Correct

```ts
// Wrong: content leaks into diagnostics.
logger.error({ error, memory }, "recall failed");

// Correct: stable metadata points to durable evidence.
logger.error(
  { code: error.code, request_id, receipt_id, retryable: error.retryable },
  "recall failed",
);
```
