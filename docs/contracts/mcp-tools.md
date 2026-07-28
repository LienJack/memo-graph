# MCP Tool and Envelope Contract

## Tool safety classes

| Class | Tools | Boundary |
| --- | --- | --- |
| Read-only | `memory_search`, `memory_get`, `memory_explain`, `memory_context_compile`, `memory_receipt_get` | No state mutation |
| Proposal | `memory_episode_commit`, `memory_propose` | Evidence/candidate only |
| Important mutation | `memory_correct`, `memory_pin`, `memory_demote`, `memory_usage_set`, `memory_revoke` | Explicit authority, exact approval binding, and receipt |
| Destructive | `memory_delete` | Tombstone, purge Saga, residual proof |

The exhaustive `MEMORY_TOOL_SAFETY_CLASS` map is the code authority. Request
payloads cannot downgrade a tool's class.

Learning feedback, pause/resume, release, and rollback are not registered in
M2. They remain behind G5.

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

## M2 implemented surface

M2 registers 13 tools over the pinned official stdio server:

| Tool | Annotation boundary | Result |
| --- | --- | --- |
| `memory_search` | read-only, idempotent, closed-world | Exact-scope L0 evidence plus canonically eligible L1 results and a retrieval receipt |
| `memory_get` | read-only, idempotent, closed-world | One exact-scope L0 record or canonically eligible L1 revision |
| `memory_explain` | read-only, idempotent, closed-world | L0 provenance or governed L1 eligibility and lineage |
| `memory_receipt_get` | read-only, idempotent, closed-world | One durable mutation or retrieval receipt |
| `memory_context_compile` | read-only, idempotent, closed-world | Frozen budgeted L0/L1 Context and retrieval receipt |
| `memory_episode_commit` | proposal, idempotent, non-destructive, closed-world | One durable episode mutation receipt |
| `memory_propose` | proposal, idempotent, non-destructive, closed-world | Evidence-bound candidate plus persisted admission outcome |
| `memory_correct` | important, idempotent, non-destructive, closed-world | Immutable successor with expected-revision CAS |
| `memory_pin` | important, idempotent, non-destructive, closed-world | Retention preference without eligibility override |
| `memory_demote` | important, idempotent, non-destructive, closed-world | Active memory returned to candidate state |
| `memory_usage_set` | important, idempotent, non-destructive, closed-world | Global or exact-Context allow/block overlay |
| `memory_revoke` | important, idempotent, non-destructive, closed-world | Immediate canonical recall exclusion |
| `memory_delete` | destructive, idempotent, closed-world | Immediate tombstone plus durable purge-job identity |

Effect-bearing important and destructive calls accept only an
`approval_id`. The local server resolves that identifier from the configured
out-of-band manifest and binds it to the principal, exact tool, safety class,
complete scope set, canonical public-request hash, and validity window.
Dry-run performs no canonical mutation and consumes no approval. A committed
same-hash idempotency replay returns its frozen result before mutable approval
state is checked; changed content under the same key returns `CONFLICT`.

The registered MCP output schema is `GovernedResponseSchema`. Every handler
returns canonical JSON text and the identical structured object. Expected
governed statuses are application results rather than transport errors.

The inspection resources are `memory://runtime/health`,
`memory://runtime/contracts`, and `memory://runtime/usage`. They expose no
memory text, query, token, credential, or data-root path.

See [Local stdio MCP explicit loop](../operations/mcp-explicit-loop.md) for
configuration and the task-start/task-end protocol. See
[Memory governance operations](../operations/memory-governance.md) before
enabling mutation or deletion.
