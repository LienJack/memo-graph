# Receipt Contract

Receipts make mutation, retrieval, evaluation, release, rollback, and purge
replayable. They are durable artifacts, not log messages.

## Common fields

Every receipt includes:

- schema version and stable receipt identifier;
- creation timestamp and durable state;
- canonical request hash;
- canonical receipt hash.

The receipt hash is SHA-256 over UTF-8 canonical JSON with only the
`receipt_hash` field omitted.

## Canonical JSON v1

- Object keys sort recursively.
- Array order is preserved.
- Only JSON primitives, arrays, and plain objects are accepted.
- Non-finite numbers, unsafe integers, negative zero, sparse arrays,
  `undefined`, `bigint`, functions, and class instances are rejected.
- No timestamps, Unicode, or numeric values are normalized implicitly.

These rules prevent insertion order or runtime-specific serialization from
changing receipt identity.

## Receipt kinds

| Receipt | Evidence |
| --- | --- |
| `RetrievalReceipt` | Included/excluded item, lane, reason codes, score, compiler and policy versions |
| `MutationReceipt` | Idempotency key, affected objects/revisions, epoch, projection jobs, warnings |
| `EvalReceipt` | Candidate, corpus hash, evaluation version, pass/fail/quarantine sets |
| `ReleaseReceipt` | Candidate, evaluation/canary authorization, previous pointer, retrieval configuration |
| `RollbackReceipt` | Exact release and configuration restored |
| `PurgeReceipt` | Tombstone epoch, stores checked, residual hashes, completion |

A purge cannot be marked complete while residual content hashes remain.
