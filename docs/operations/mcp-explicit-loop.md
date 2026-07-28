# Local stdio MCP explicit loop

## Boundary

The M1 server exposes governed local memory through explicit MCP calls. It
cannot observe Codex conversation text, task starts, task ends, or resources
that the host did not send. Reading an MCP resource also does not place that
resource in model Context.

The process is bound to one configured principal. Actor, authority, and scope
values in tool arguments are untrusted claims and cannot expand the process
configuration.

## Build

Use the pinned Node 24 runtime and frozen workspace:

```bash
pnpm install --frozen-lockfile
pnpm build:runtime
```

The executable entry is:

```text
packages/mcp-server/dist/cli.js
```

It reserves stdout for MCP protocol frames. Lifecycle and transport
diagnostics are content-free JSON metadata on stderr.

## Runtime configuration

Create a private JSON file outside the repository:

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
  "default_token_budget": 1800,
  "lane_policy": {
    "allowed_lanes": [
      "recent_l1",
      "topic",
      "scenario_procedure",
      "core",
      "relation_sqlite"
    ],
    "limits": {
      "max_candidates_per_lane": 20,
      "relation_max_depth": 2,
      "relation_max_fanout": 5,
      "max_concurrent_lanes": 2
    }
  }
}
```

The data root must satisfy the local storage safety contract. Secret evidence
and known cloud-synchronized or removable paths fail closed in M1.
If `lane_policy` is omitted, the runtime preserves the accepted L0/L1
baseline. A request-level `lane_overrides` may disable lanes or reduce limits,
but it cannot enable a lane or raise a limit beyond this operator policy.

Configure Codex with absolute paths:

```toml
[mcp_servers.memo_graph_memory]
command = "/absolute/path/to/node-24"
args = [
  "/absolute/path/to/memo-graph/packages/mcp-server/dist/cli.js",
  "--config",
  "/absolute/private/path/memo-graph-mcp.json"
]
```

Restart the Codex host after changing its MCP configuration. Inspect
`memory://runtime/health`, `memory://runtime/contracts`, and
`memory://runtime/usage` to verify discovery; these reads do not create recall
audit rows or change the ledger epoch.

## Task start

Call `memory_context_compile` explicitly with:

- a read-only envelope whose actor and scopes match the configured principal;
- one `RecallRequest` with the same request ID and scopes;
- the current goal, query, `as_of` timestamp, sensitivity posture, and a hard
  budget from 1 through 32,000 tokens.

Use the status mechanically:

| Status | Host action |
| --- | --- |
| `OK` | Use only the returned frozen Context slice. |
| `NO_MATCH` | Continue without claiming that prior memory exists. |
| `POLICY_EXCLUDED` | Continue without the excluded content; surface reason codes when useful. |
| `DEGRADED` | Use the named partial fallback, retain warnings, and avoid treating omitted memory as absent. |
| `FAILED` | Do not fabricate memory; retry only when `retryable=true`. |

The returned slice contains source evidence IDs, authority, scope,
sensitivity, selection reason, uncertainty, token estimates, and a canonical
`frozen_hash`. Its `token_used` never exceeds the caller's budget.

## During the task

Use:

- `memory_search` for exact-scope FTS evidence;
- `memory_get` for one evidence ID and exact scope;
- `memory_explain` for source, hash, and episode membership;
- `memory_receipt_get` for a durable mutation or retrieval receipt.

These calls can append retrieval audit artifacts, but they do not change
evidence, episodes, idempotency keys, outbox content, or the canonical ledger
epoch.

## Task end

Call `memory_episode_commit` explicitly. The proposal envelope must use the
`memory_episode_commit` tool name, the `proposal` safety class, and a stable
idempotency key. The payload must contain:

- one sealed `Episode`;
- its ordered `EvidenceRecord` list;
- any blob bodies as base64 with matching content hashes.

The evidence actor, authority, and scope must remain within the configured
principal. Repeating the same idempotency key and content returns the identical
mutation receipt and does not create another episode. Reusing the key for
different content returns `CONFLICT`.

M1 records only L0 evidence. It does not silently promote evidence into L1,
publish learned behavior, or enable destructive tools.

## Verification

```bash
pnpm test:mcp
pnpm test:integration -- codex-explicit-loop
pnpm test:storage
pnpm test:recovery
```

The integration suite starts the official MCP client and actual stdio child
process, verifies initial `NO_MATCH`, commits an episode, stops the process,
starts a new process on the same ledger, and recalls a hash-valid frozen
Context slice.
