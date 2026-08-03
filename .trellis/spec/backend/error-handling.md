# Error Handling

## Scenario: MCP Request and Recall Boundary

### 1. Scope / Trigger

Apply when accepting an MCP request, authorizing actor/scope claims, compiling
Context, returning a mutation result, or reporting a derived-lane failure.

### 2. Signatures

```ts
authorizeRequestClaims(
  principal: LocalPrincipal,
  request: RequestEnvelope,
): AuthorityDecision
```

Runtime schemas:

```text
ReadRequestEnvelopeSchema
ProposalRequestEnvelopeSchema
MutationRequestEnvelopeSchema
GovernedResponseSchema
McpErrorSchema
```

### 3. Contracts

- Parse `unknown` once through the owning schema.
- Request actor/scope fields are claims checked against `LocalPrincipal`.
- Proposal and mutation calls require an idempotency key.
- Important/destructive mutations carry the declared safety class; payloads
  cannot downgrade a tool.
- Recall status is a discriminated union:
  `OK | NO_MATCH | POLICY_EXCLUDED | DEGRADED | FAILED`.
- Failures use the stable code set in `McpErrorCodeSchema`.
- Every safely processed request returns or references a receipt.
- `memory_evidence_ingest` is proposal-class. Its source batch is decoded
  strictly, its exact scope must be present in the envelope, and the adapter's
  mapped authority must also be allowed by `LocalPrincipal`.

### 4. Validation & Error Matrix

| Condition | Code/status |
| --- | --- |
| Malformed payload | `INVALID_INPUT` |
| Secret or oversized evidence-ingest body | `INVALID_INPUT`, zero write |
| Adapted source authority not allowed | `PERMISSION_DENIED`, zero write |
| Principal/authority/scope denied | `PERMISSION_DENIED` |
| Concurrent state conflict | `CONFLICT` |
| Expected revision mismatch | `STALE_REVISION` |
| No trusted approval exists for an effect-bearing mutation | `APPROVAL_REQUIRED` |
| Approval expired, changed, mismatched, forged, or already consumed | `APPROVAL_INVALID` |
| Optional projection down, fallback works | `DEGRADED` |
| Relevant candidates all ineligible | `POLICY_EXCLUDED` |
| No relevant live candidate exists | `NO_MATCH` |
| Purge has residual content | `INCOMPLETE_PURGE` |
| Cannot serve safely | `FAILED` / `INTERNAL_FAILURE` |

### 5. Good / Base / Bad Cases

- Good: return `POLICY_EXCLUDED` with count and reason codes when relevant
  memory exists outside policy.
- Base: return `NO_MATCH` when no relevant live memory exists.
- Bad: catch every failure and return `[]`.

### 6. Tests Required

- Every tool name matches exactly one safety class.
- A destructive tool cannot parse as read-only/proposal/important mutation.
- Actor, authority, scope, and destructive-enable mismatches are distinct.
- Every response union arm parses and cannot be confused with `OK`.
- Stale revisions, incomplete purge, and fallback states preserve typed codes.
- Approval failures never expose registry paths, grant bodies, or request
  content and occur before canonical mutation.

### 7. Wrong vs Correct

#### Wrong

```ts
try {
  return await recall(query);
} catch {
  return [];
}
```

#### Correct

```ts
return {
  status: "DEGRADED",
  receipt_id,
  fallback_lane: "recent",
  warnings: ["FTS projection unavailable"],
  data,
};
```

## Exception handling

Contract parse errors are mapped at the transport boundary. Domain/storage code
returns typed results or throws known domain errors; only the boundary maps
them to MCP responses. Never log or return raw memory content in error details.
