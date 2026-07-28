# MCP Tool and Envelope Contract

## Tool safety classes

| Class | Tools | Boundary |
| --- | --- | --- |
| Read-only | `memory_search`, `memory_get`, `memory_explain`, `memory_context_compile`, `memory_receipt_get` | No state mutation |
| Proposal | `memory_episode_commit`, `memory_propose`, `memory_feedback` | Evidence/candidate only |
| Important mutation | correction, pin, demote, usage, revoke, learning pause/resume/release/rollback | Explicit authority and receipt |
| Destructive | `memory_delete` | Tombstone, purge Saga, residual proof |

The exhaustive `MEMORY_TOOL_SAFETY_CLASS` map is the code authority. Request
payloads cannot downgrade a tool's class.

## Request claims

Every request carries a configured actor claim, one or more scopes, purpose,
reason, timestamp, and stable request identifier. Proposal and mutation calls
also require an idempotency key. Mutation calls carry an expected revision
where compare-and-swap applies.

Actor and scope values in a request are claims, not authentication. The server
binds the process to one `LocalPrincipal` and rejects:

- principal mismatch;
- unconfigured authority;
- scope outside the configured allowlist;
- destructive calls while destructive tools are disabled.

## Result status

Recall cannot collapse all empty outcomes into one list:

| Status | Meaning |
| --- | --- |
| `OK` | Governed result or intentionally empty compiled slice |
| `NO_MATCH` | No relevant live memory exists |
| `POLICY_EXCLUDED` | Relevant memory exists but is ineligible |
| `DEGRADED` | A named lane failed and a safe fallback served the request |
| `FAILED` | The request could not be served safely |

Errors use a stable taxonomy for invalid input, permission denial, conflict,
stale revision, projection outage, incomplete purge, degraded recall, and
internal failure.

## Context slices

`ContextSlice` is frozen, hash-addressed, compiler-versioned, and
token-budgeted. Every item retains scope, authority, sensitivity, lifecycle,
evidence identifiers, selection reason, uncertainty, and token estimate.
Compilation cannot mutate long-term memory.

## M1 implemented surface

M1 registers six tools over the pinned official stdio server:

| Tool | Annotation boundary | M1 result |
| --- | --- | --- |
| `memory_search` | read-only, idempotent, closed-world | Exact-scope SQLite FTS evidence and a retrieval receipt |
| `memory_get` | read-only, idempotent, closed-world | One exact-scope L0 evidence record |
| `memory_explain` | read-only, idempotent, closed-world | Evidence provenance and episode membership |
| `memory_receipt_get` | read-only, idempotent, closed-world | One durable mutation or retrieval receipt |
| `memory_context_compile` | read-only, idempotent, closed-world | Frozen budgeted L0 Context and retrieval receipt |
| `memory_episode_commit` | proposal, idempotent, non-destructive, closed-world | One durable episode mutation receipt |

The registered MCP output schema is `GovernedResponseSchema`. Every handler
returns canonical JSON text and the identical structured object. Expected
governed statuses are application results rather than transport errors.

The inspection resources are `memory://runtime/health`,
`memory://runtime/contracts`, and `memory://runtime/usage`. They expose no
memory text, query, token, credential, or data-root path.

See [Local stdio MCP explicit loop](../operations/mcp-explicit-loop.md) for
configuration and the task-start/task-end protocol.
