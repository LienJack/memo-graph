# Local vector projection recovery runbook

## Purpose and authority

This runbook recovers the optional local semantic-vector projection.
`<data-root>/ledger/memory.db` remains authoritative for identity, scope,
lifecycle, validity, sensitivity, approval, evidence, correction, conflict,
tombstone, purge, receipts, and Context eligibility.

Vector files are disposable derived state. Keep `semantic_vector` disabled,
or accept its typed vector-free fallback, until the exact epoch, generation,
frontier, logical digest, and canonical post-validation checks are complete.
G4B is currently `NO-GO`; these procedures preserve recovery evidence and do
not authorize enablement.

## 1. Materialize the private model snapshot

Model acquisition is an explicit operator action outside runtime. Place only
the four pinned files beneath a private local model root:

```text
Xenova/multilingual-e5-small/
├── config.json
├── onnx/model_int8.onnx
├── tokenizer.json
└── tokenizer_config.json
```

Verify every byte against the current G4B reproducibility manifest before
starting a vector child. Reject missing, extra, changed, symlinked, or
wrong-sized artifacts. Do not log the private model root, model contents,
tokens, embeddings, memory text, query text, database pages, or WAL pages.

The runtime sets Transformers to local-model mode with remote access
disabled. It must never download a model or send memory/query content to a
remote embedding service. Installation may materialize dependencies, but
runtime operation is no-network.

## 2. Inspect without exposing content

Read `vector_projection_status` and the exact-scope checkpoint from SQLite.
Record only:

- configuration mode: `disabled`, `evaluating`, or `enabled`;
- checkpoint state: `disabled`, `pending`, `building`, `quarantined`,
  `published`, or `degraded`;
- desired/active epoch and generation IDs;
- ledger, tombstone, and source-frontier hashes;
- logical digest, counts, queue depth, lease identity, and stable failure
  category;
- child health, process generation, restart count, duration, and bounded
  resource measurements.

The filesystem path is derived from a one-way hash of principal plus exact
scope. Clear principal or scope values must not appear in directory or
database filenames. Directory presence alone never proves readiness.

## 3. Disable and contain

Set vector projection mode to `disabled` and remove `semantic_vector` from
the lane policy before changing derived files. Stop only the vector child.
If graceful shutdown misses its bound, terminate that child and preserve the
SQLite writer and vector-free MCP runtime.

Treat failures consistently:

| Category | Examples | Runtime behavior | Recovery |
|---|---|---|---|
| Model/dependency | missing model, identity mismatch, dependency unavailable | typed degradation | verify or reinstall exact snapshot |
| Index | missing, locked, corrupt | typed degradation | quarantine and rebuild |
| Freshness | stale epoch/frontier, rebuilding | typed degradation | finish coherent publication |
| Process | timeout, exit, cooldown | typed degradation | bounded retry or reopen |
| Protocol/resource | malformed IPC, path escape, size limit | reject and disable | investigate before rebuild |

No typed failure may become a clean vector `NO_MATCH`. The active supported
fallback remains FTS5/recency, layered projections, and SQLite relations.

## 4. Rebuild one exact scope

1. Re-read the canonical SQLite frontier and governed non-sensitive L1 source
   list for one principal and exact scope.
2. Exclude `sensitive`, `secret`, non-live, expired, conflicted, blocked,
   demoted, revoked, tombstoned, purged, or superseded revisions.
3. Open a fresh unpublished generation for the exact verified epoch.
4. Embed bounded batches in the isolated child.
5. Replace the scope transactionally in `sqlite-vec`.
6. Read back the normalized snapshot and verify record count, frontier,
   epoch, generation, and logical digest.
7. Re-read SQLite. If the frontier changed, mark the job stale and discard
   the candidate generation.
8. Publish the checkpoint only when the current lease, desired epoch,
   generation, frontier, and digest still match.

Never mutate a published generation in place and never copy a scope index
between principals or scopes.

## 5. Full rebuild and epoch migration

Use `VectorFullRebuilder` with a new epoch and `activate: false`.

1. Register the complete epoch contract, including the current dependency
   lock hash and all four model-file identities.
2. Configure projection mode `evaluating`.
3. Drain bounded outbox rounds until every configured scope is published or
   any scope becomes degraded.
4. Compare incremental and rebuilt logical digests.
5. Simulate interruption and resume from SQLite leases/checkpoints.
6. Verify unrelated scopes remain unchanged.
7. Only an independently verified GO gate may switch to `enabled`. For the
   current NO-GO result, return to `disabled` and retain evidence only.

An epoch migration is a new derived population. Never reinterpret vectors
from an older model, lock, normalization, dimensions, prefix, pooling, index,
or projection schema as belonging to the new epoch.

## 6. Corruption, outage, restore, and purge

- **Corruption/lock:** mark the exact scope degraded, stop the child,
  quarantine only its derived scope directory, and rebuild from SQLite.
- **Model/process outage:** keep the vector lane unavailable, serve the
  vector-free path, and use bounded cooldown. Do not auto-download or switch
  candidates.
- **SQLite restore:** mark all vector checkpoints degraded and retire
  unfinished pre-restore jobs. Rebuild from the restored authoritative state;
  copied vector files never become ready by presence.
- **Correction/revoke/tombstone:** canonical post-validation suppresses the
  next read before asynchronous cleanup; the outbox then publishes a new
  generation.
- **Purge:** stop affected work, delete the obsolete exact-scope generation
  and sidecars, and scan vector database/WAL/temp/quarantine/backup,
  diagnostics, reports, and tests for prohibited plaintext.

Deleting `<data-root>/derived/vector` is safe only after rechecking the exact
canonical data root and stopping vector children. Never delete
`<data-root>/ledger`, `<data-root>/blobs`, or the data root.

## 7. Verification and rollback

Run with the pinned runtime:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm test:governance
pnpm test:recovery
pnpm vitest run tests/integration/g4b-artifact-integrity.test.ts
pnpm run verify:g4b
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Rollback means: disable `semantic_vector`, stop its child, retain or remove
only derived vector state, and continue on the supported vector-free runtime.
Do not down-migrate additive SQLite delivery tables or rewrite issued Context
and receipt artifacts.

The child is an availability and crash-containment boundary for trusted
native dependencies. It is **not an OS sandbox** and does not defend against
malicious package code or same-UID filesystem access. G4B tested only Darwin
arm64 with Node 24. A future GO would be opt-in local evidence on its exact
identity, not M6 production readiness. NO-GO is a complete supported outcome.
