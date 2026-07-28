# Agent Memory Runtime M0 contracts and replay corpus

## Goal

Freeze the runtime boundary and measurement system before any canonical storage
or MCP behavior is implemented. M0 delivers U1: repository/toolchain contracts,
typed memory and MCP artifacts, deterministic receipts, a threat model, a
frozen replay corpus, workload envelopes, and an explicit G0 decision.

## Authority

1. `docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md`
2. Parent `prd.md`, `design.md`, and `implement.md`
3. Parent `research/research-handoff.md`
4. `docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md`

This child does not add product requirements or renumber R1-R20, F1-F4, or
AE1-AE8.

## Requirements

- Establish a pinned TypeScript, Node LTS, pnpm, ESM, lint, test, and build
  baseline.
- Probe the official MCP TypeScript SDK and SQLite driver candidates against
  the current supported runtime before pinning them.
- Define runtime-validated contracts for memory artifacts, lifecycle,
  authority, scope, validity, sensitivity, MCP envelopes, errors, receipts,
  learning candidates, evaluation, release, rollback, and purge.
- Treat request actor/scope values as claims checked against a configured local
  principal; payloads cannot self-authorize.
- Define canonical serialization and SHA-256 receipt/fixture hashing.
- Freeze replay cases for normal recall, conflict, correction, deletion,
  privacy, persisted prompt injection, temporal and multi-hop queries,
  degraded/failure states, and negative transfer.
- Keep calibration, holdout, and transfer partitions mechanically separate.
- Declare workload and token-budget envelopes before benchmark implementation.
- Record ADRs for runtime/SQLite, MCP SDK, and the graph adoption gate.
- Record the local threat model and data-at-rest decision.
- Do not create migrations, SQLite repositories, MCP handlers, graph/vector
  adapters, or learning publication behavior in M0.

## Acceptance Criteria

- [x] `pnpm test:contract` proves valid examples, invalid combinations,
  deterministic serialization, and receipt identity/status.
- [x] `pnpm test:fixtures` verifies manifest structure, immutable content
  hashes, declared outcomes, and partition isolation.
- [x] `pnpm lint` and `pnpm typecheck` pass.
- [x] Every planned public artifact has one runtime schema and one inferred
  TypeScript type owned by the contracts package.
- [x] Mutation, evaluation, release, rollback, and purge results are
  receipt-bearing and replayable.
- [x] Replay fixtures cover all declared risk families without exposing
  holdout/transfer payloads to calibration consumers.
- [x] ADRs record exact dependency/runtime choices and probe evidence.
- [x] Threat model covers local file access, scope leakage, persisted
  injection, projection resurrection, tool replay, and learning overfit.
- [x] `docs/evaluations/g0-decision.md` records tested commit/lock hash,
  versions, fixture hashes, unresolved debt, and `GO` or `HOLD`.
- [x] No M1+ production behavior exists before the G0 decision.

## Notes

- Parent gate: G0.
- Rollback: delete the M0-only scaffold and revise contracts/fixtures; do not
  proceed into migrations or MCP handlers while G0 is `HOLD`.
