# M1B Implementation Checklist

## 1. Task and contracts

- [x] Validate and activate this child on its branch.
- [x] Pin bounded implementation/check context.
- [x] Add official MCP client 2.0.0 for real stdio integration tests.
- [x] Add contract and integration regression tests for every handler boundary.

## 2. Recall storage

- [x] Add immutable migration `0003-recall-context.sql`.
- [x] Add exact-scope evidence get/explain and receipt lookup worker operations.
- [x] Add atomic RecallRequest, RetrievalReceipt, ContextSlice, and item
  recording without advancing the canonical epoch.
- [x] Enforce append-only recall/context artifacts and replay their hashes.
- [x] Expose canonical and operational counts separately.

## 3. Kernel and compiler

- [x] Implement configuration-owned local principal decoding.
- [x] Reject principal, authority, or scope mismatch before storage.
- [x] Map storage OK/NO_MATCH/DEGRADED/errors to governed MCP statuses.
- [x] Implement deterministic token estimation and whole-item budget packing.
- [x] Implement sensitive exclusion, deduplication, ranking, provenance, and
  uncertainty.
- [x] Seal and replay ContextSlice and RetrievalReceipt artifacts.

## 4. MCP adapter

- [x] Register five read-only tools and one proposal tool with exact
  annotations.
- [x] Return matching structured and text content.
- [x] Register health, contracts, and usage inspection resources.
- [x] Reserve stdout for MCP and emit content-free diagnostics to stderr.
- [x] Implement config decoding, stdio startup, and graceful shutdown.

## 5. Explicit loop and operations

- [x] Add a real official-client/stdin/stdout integration harness.
- [x] Prove initial NO_MATCH, episode commit, process restart, later recall,
  context hash replay, and commit idempotency.
- [x] Prove zero cross-scope results and no unauthorized audit rows.
- [x] Prove resources and read tools leave canonical epoch/counts unchanged.
- [x] Add Codex configuration plus task-start/task-end usage guide.

## 6. G1

- [ ] Run M0, M1A, MCP, integration, recovery, privacy, lint, typecheck, build,
  frozen-install, audit, and baseline benchmark gates.
- [ ] Record tested commit, lock/schema/migration/fixture hashes, stdio
  transcript evidence, performance, and debt in `g1-decision.md`.
- [ ] Commit, archive, and journal M1B before activating M2.
