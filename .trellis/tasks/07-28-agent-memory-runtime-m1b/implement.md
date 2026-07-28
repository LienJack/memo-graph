# M1B Implementation Checklist

## 1. Task and contracts

- [x] Validate and activate this child on its branch.
- [x] Pin bounded implementation/check context.
- [ ] Add official MCP client 2.0.0 for real stdio integration tests.
- [ ] Write failing contract and integration tests before handlers.

## 2. Recall storage

- [ ] Add immutable migration `0003-recall-context.sql`.
- [ ] Add exact-scope evidence get/explain and receipt lookup worker operations.
- [ ] Add atomic RecallRequest, RetrievalReceipt, ContextSlice, and item
  recording without advancing the canonical epoch.
- [ ] Enforce append-only recall/context artifacts and replay their hashes.
- [ ] Expose canonical and operational counts separately.

## 3. Kernel and compiler

- [ ] Implement configuration-owned local principal decoding.
- [ ] Reject principal, authority, or scope mismatch before storage.
- [ ] Map storage OK/NO_MATCH/DEGRADED/errors to governed MCP statuses.
- [ ] Implement deterministic token estimation and whole-item budget packing.
- [ ] Implement sensitive exclusion, deduplication, ranking, provenance, and
  uncertainty.
- [ ] Seal and replay ContextSlice and RetrievalReceipt artifacts.

## 4. MCP adapter

- [ ] Register five read-only tools and one proposal tool with exact
  annotations.
- [ ] Return matching structured and text content.
- [ ] Register health, contracts, and usage inspection resources.
- [ ] Reserve stdout for MCP and emit content-free diagnostics to stderr.
- [ ] Implement config decoding, stdio startup, and graceful shutdown.

## 5. Explicit loop and operations

- [ ] Add a real official-client/stdin/stdout integration harness.
- [ ] Prove initial NO_MATCH, episode commit, process restart, later recall,
  context hash replay, and commit idempotency.
- [ ] Prove zero cross-scope results and no unauthorized audit rows.
- [ ] Prove resources and read tools leave canonical epoch/counts unchanged.
- [ ] Add Codex configuration plus task-start/task-end usage guide.

## 6. G1

- [ ] Run M0, M1A, MCP, integration, recovery, privacy, lint, typecheck, build,
  frozen-install, audit, and baseline benchmark gates.
- [ ] Record tested commit, lock/schema/migration/fixture hashes, stdio
  transcript evidence, performance, and debt in `g1-decision.md`.
- [ ] Commit, archive, and journal M1B before activating M2.
