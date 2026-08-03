# Local graph projection recovery runbook

## Purpose and authority boundary

This runbook recovers the optional local LadybugDB projection. SQLite under
`<data-root>/ledger/memory.db` remains authoritative throughout. Never repair
memory identity, lifecycle, scope, evidence, correction, tombstone, purge, or
receipt state by editing graph files.

Keep the graph lane disabled, or accept its typed SQLite fallback, until the
exact-scope checkpoint and logical digest are verified as ready.

## 1. Inspect without exposing content

1. Resolve the configured canonical data root.
2. Inspect MCP runtime health and `graph_projection_status`.
3. For each affected principal and exact scope, record:
   - checkpoint status;
   - ledger, tombstone, projection, and graph-projection epochs;
   - source/projection frontier hashes;
   - logical digest;
   - backend/package/native/lock identity;
   - content-free failure code.
4. Inspect `<data-root>/derived/graph/active-generation.json`.
5. Confirm SQLite search/recall remains available.

Do not print memory text, projection payloads, evidence bodies, raw IPC,
database pages, WAL pages, or arbitrary Cypher. Hashes, identifiers, counts,
versions, durations, and stable failure codes are sufficient.

## 2. Disable and contain

Disable `relation_graph` in operator policy before changing graph files. Stop
the graph child gracefully; if it does not stop within the bounded shutdown
window, terminate that child only. Do not stop or replace the SQLite writer.

Treat these failure dispositions consistently:

| Category | Examples | Runtime action | Recovery |
| --- | --- | --- | --- |
| Configuration | disabled, optional dependency missing | SQLite fallback | none until configured |
| Availability | startup, child exit, circuit open | SQLite fallback | bounded retry/cooldown |
| Protocol/resource | malformed response, limit, deadline | SQLite fallback | reject or bounded replacement |
| Freshness | pending, stale, rebuilding, postvalidation | SQLite fallback | wait for coherent delivery |
| Store/integrity | locked, corrupt, identity/digest mismatch | SQLite fallback | quarantine and rebuild |

## 3. Quarantine or delete graph state

- Never quarantine the active generation in place.
- For a failed candidate generation, move only its exact directory from
  `<data-root>/derived/graph/generations/` into the graph quarantine directory
  using the runtime's path-confined quarantine operation.
- Retain only the bounded evidence needed by the active incident; remove older
  derived quarantine/backup copies using an explicit exact path after their
  hashes and failure category are recorded.
- To prove disposable recovery, it is safe to delete the exact
  `<data-root>/derived/graph` directory only after the child is stopped and the
  canonical data root has been rechecked. Never delete `<data-root>/ledger`,
  `<data-root>/blobs`, or the data root itself.

All graph-file deletion is recoverable by rebuilding from SQLite. It does not
delete authoritative memory.

## 4. Mark fallback and rebuild

1. Mark graph restore/recovery unavailable in SQLite. This prevents a copied
   or stale graph generation from becoming eligible.
2. Read the complete ordered canonical graph snapshots from SQLite.
3. Compute the global logical digest.
4. Create a fresh generation; never mutate the published generation.
5. Replace every exact scope from its SQLite snapshot.
6. Read every scope back and compare normalized logical equality and the
   global digest.
7. Close and reopen the candidate, then repeat logical verification.
8. Re-read SQLite and abort if its canonical frontier changed.
9. Publish the new active-generation manifest atomically.
10. Reopen the published generation and publish exact-scope ready checkpoints
    only after another successful comparison.

Any failure leaves graph unavailable and SQLite fallback active. Quarantine a
failed unpublished candidate. Never publish partial readiness.

## 5. Restore and stale-copy protection

After restoring a SQLite backup, graph checkpoints must remain unavailable
even when a copied graph directory and active manifest exist. Rebuild a fresh
generation from the restored SQLite state. A stale extra path must disappear
from the rebuilt logical snapshot before any scope becomes ready.

## 6. Verify and publish evidence

Verification is complete only when:

- SQLite integrity/foreign-key and authoritative recall checks pass;
- each intended graph scope is ready with an exact frontier, digest, and
  backend identity;
- incremental and full-rebuild global logical digests match;
- graph-disabled and outage paths still serve SQLite;
- correction, usage block, demote, revoke, tombstone, and purge suppress the
  next graph read;
- graph database, WAL, generation manifest, quarantine, backup, IPC-derived
  diagnostics, error receipts, benchmark reports, and test artifacts contain
  no purged plaintext;
- process generation, restart count, queue depth, active requests, retained
  quarantine bytes, and disk bytes remain within the declared gate.

Record only command identity, exit status, counts, durations, hashes, versions,
frontiers, digests, and stable failure codes. Keep `relation_graph` disabled if
any check is missing, mixed, stale, or failed.

Run the repository-owned verification commands with the pinned Node runtime:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm test:governance
pnpm test:recovery
pnpm vitest run tests/security/graph-content-residual.test.ts
pnpm lint
pnpm typecheck
pnpm build
```

The active path is obtained from the path-confined graph layout and
`active-generation.json`; the exact frontier/digest comes from
`graphProjectionCheckpoint`; fallback health comes from SQLite/runtime health;
publication evidence comes from the rebuild result, active manifest, delivery
receipts, and ready checkpoints. Do not infer any of these from directory
presence alone.

## 7. Rollback

Disable `relation_graph`, stop the graph child, and retain or remove only the
derived graph state. Keep additive SQLite delivery tables for audit. Continue
with `relation_sqlite` and `recent_l1`; do not down-migrate SQLite or rewrite
issued Context/receipt artifacts.
