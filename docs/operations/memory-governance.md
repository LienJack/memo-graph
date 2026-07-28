# Memory Governance Operations

## Boundary

M2 makes L1 admission, correction, controls, tombstones, purge evidence, and
restore verification executable. SQLite remains the only authority. FTS,
Context copies, blobs, backups, caches/exports, and future graph/vector stores
are projections or residual-bearing derivatives.

This runbook is local-only. It does not provide an approval UI, remote
identity, a background purge daemon, or fleet-wide tombstone-frontier
distribution.

## Safe server configuration

Keep destructive tools disabled unless an operator is intentionally executing
a reviewed delete:

```json
{
  "data_root": "/absolute/local/path/memo-graph-data",
  "principal_id": "user_local",
  "allowed_scopes": [
    {
      "kind": "workspace",
      "id": "workspace_local"
    }
  ],
  "allowed_authorities": [
    "user_stated",
    "tool_result"
  ],
  "destructive_tools_enabled": false,
  "approval_manifest_path": "/absolute/private/path/approvals.json",
  "default_token_budget": 1800,
  "lane_policy": {
    "allowed_lanes": [
      "recent_l1"
    ],
    "limits": {
      "max_candidates_per_lane": 100,
      "relation_max_depth": 2,
      "relation_max_fanout": 20,
      "max_concurrent_lanes": 2
    }
  }
}
```

`destructive_tools_enabled` defaults to `false`. Setting it to `true` is only
one half of delete authorization: every effect-bearing delete still requires
an exact, unexpired, single-use approval.

The default `lane_policy` keeps the accepted M2 L0/L1 Context path. Enabling
L2/L3 lanes is an operator decision; tool requests may only narrow the
configured lane set and limits.

If `approval_manifest_path` is omitted, the runtime uses a deny-all approval
registry. The configured file must be:

- an absolute path to a regular file;
- owned by the current process user;
- neither a symlink nor group/world writable;
- valid strict `ApprovalRegistryManifest` JSON;
- unchanged between verification and the storage transaction.

Keep the manifest outside the repository and set its mode to `0600`.

## Approval binding

An MCP mutation carries only `approval_id`; it cannot supply or downgrade the
grant. The out-of-band grant is bound to:

- `principal_id`;
- exact tool and safety class;
- the complete sorted-equivalent scope set;
- the canonical SHA-256 of the public request;
- `issued_at` and `expires_at`;
- its own canonical digest.

Generate the request and grant with the exported contract schemas and
`canonicalSha256` / `canonicalSha256Omitting`. Do not hand-edit hashes. A
changed tool, scope, request body, or idempotency key requires a new grant.

The registry is re-read immediately before the storage call. The storage
transaction revalidates and consumes the approval together with the effect,
epoch, outbox job, and receipt. A failed transaction does not consume it. A
successful same-request retry replays its durable receipt without requiring a
second approval.

## Mutation workflow

1. Read the target with `memory_get` or `memory_explain`.
2. Record the exact current `revision_id`.
3. Build the final request with a fresh idempotency key and that
   `expected_revision_id`.
4. For an effect, create the exact out-of-band grant and place the private
   manifest atomically.
5. Submit the mutation and retain its receipt identifier.
6. Read the receipt with `memory_receipt_get`.
7. Compile a new Context to verify the current governed view.

Use `dry_run=true` before a sensitive operation when available. Dry-run changes
no canonical pointer, lifecycle, epoch, approval state, or projection.

Control semantics are intentionally distinct:

| Tool | Effect |
| --- | --- |
| `memory_correct` | Appends an immutable successor with CAS |
| `memory_pin` | Changes retention preference only |
| `memory_demote` | Returns the memory to candidate state |
| `memory_usage_set` | Allows or blocks global/exact-Context use |
| `memory_revoke` | Immediately excludes the memory from recall |
| `memory_delete` | Tombstones immediately and creates a purge job |

Pin never overrides expiry, conflict, sensitivity, missing lineage, usage
block, revocation, or tombstone.

## Delete and purge

`memory_delete` commits the tombstone before asynchronous cleanup. From that
transaction onward, canonical reads and new Context compilation exclude the
memory even if a derived copy still awaits cleanup.

M2 does not run a background purge scheduler. The local storage adapter exposes
the maintenance operation:

```ts
await storage.runPurge({ purge_job_id });
```

Run it with the `purge_job_id` returned by delete, preserve the
`PurgeReceipt`, and retry the same job after interruption. A complete receipt
requires nine verified store outcomes and zero residual hashes. Shared live
lineage produces an honest partial result with named residual debt; it must
remain tombstoned and be retried after the last live reference is removed.

Never translate partial or failed purge into success. M6 owns a supported
long-running operational scheduler and purge-audit command.

## Context replay

Historical Context artifacts stay immutable, but replay is governed by current
canonical state:

- a corrected, demoted, blocked, revoked, expired, or otherwise ineligible L1
  item fails closed with `CONFLICT`;
- an unredacted item whose memory is tombstoned fails with
  `INCOMPLETE_PURGE`;
- after verified purge, the historical item can replay only as redacted
  `[PURGED]` content with valid item and frozen hashes.

Never treat a historical Context file as an authorization result.

## Backup and restore

Every restore requires `minimumTombstoneEpoch` from a trusted source outside
the snapshot:

```ts
await restoreBackupToEmptyDataRoot({
  backup,
  dataRoot: "/absolute/new/empty/data-root",
  minimumTombstoneEpoch: trustedFrontier,
});
```

The destination must not exist. Restore stages privately and publishes by
atomic rename only after migration, SQLite integrity/foreign-key, blob,
canonical lifecycle, Context hash, receipt hash, and purge-state checks pass.

A backup behind the trusted frontier is rejected before staging. A snapshot
with pending/running/failed purge is rejected. An honest partial snapshot may
restore only when its latest receipt names non-empty residual hashes and no
store failed; its tombstone remains authoritative.

M2 does not durably distribute the trusted frontier across machines. Until M6,
the operator must preserve it separately from backup media and refuse restore
when it is unavailable.

## Failure handling

| Result | Operator action |
| --- | --- |
| `APPROVAL_REQUIRED` | Create the exact out-of-band grant; do not weaken policy |
| `APPROVAL_INVALID` | Recompute the request/grant and inspect path, owner, mode, digest, and expiry |
| `STALE_REVISION` | Re-read the target and decide against the new current revision |
| `CONFLICT` | Do not reuse an idempotency key for changed content |
| `INCOMPLETE_PURGE` | Keep the tombstone, inspect named store outcomes, retry the same purge job |
| `STALE_TOMBSTONE_FRONTIER` | Reject the backup and restore from a current snapshot |
| `PERMISSION_DENIED` | Correct server principal/scope policy; never trust request claims |

On any unexplained resurrection, approval bypass, lost update, or unverifiable
purge, freeze new L1 admission and serve L0 or the last verified read-only L1
state until the incident is resolved.
