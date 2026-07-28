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
