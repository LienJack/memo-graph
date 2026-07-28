# M0 Implementation Checklist

## 1. Authorization and setup

- [x] Record the user's 2026-07-28 implementation authorization on the parent.
- [x] Create this independently gated M0 child.
- [x] Validate and activate this child with `task.py start`.
- [x] Record current Node, pnpm, MCP SDK, SQLite, and platform probe results.

## 2. Toolchain

- [x] Add the pnpm workspace, TypeScript ESM base, lint, typecheck, test, and
  build scripts.
- [x] Pin exact runtime and dependency versions with a lockfile.
- [x] Keep local runtime `data/` ignored.

## 3. Contracts

- [x] Write failing tests for enums, cross-field invariants, status unions,
  canonical JSON, hashes, and receipt requirements.
- [x] Implement common schemas and canonical serialization.
- [x] Implement memory artifact schemas.
- [x] Implement MCP envelopes, safety classes, local-principal claims, and
  typed errors/statuses.
- [x] Implement mutation, retrieval, evaluation, release, rollback, and purge
  receipt schemas.
- [x] Implement learning trace and candidate schemas.
- [x] Export all schemas and inferred types from one package boundary.

## 4. Frozen evaluation inputs

- [x] Define the replay manifest schema.
- [x] Add calibration, holdout, and transfer cases for every M0 risk family.
- [x] Compute and freeze canonical content hashes.
- [x] Test hash integrity, expected outcomes, and partition isolation.
- [x] Freeze the performance and token-budget envelope.

## 5. Architecture evidence

- [x] Record the runtime/SQLite driver ADR and compatibility probe.
- [x] Record the official MCP SDK line ADR.
- [x] Record graph selection criteria without selecting a backend.
- [x] Publish artifact, MCP, and receipt contract docs.
- [x] Publish the threat model and data-at-rest posture.

## 6. G0

- [x] Run `pnpm test:contract`.
- [x] Run `pnpm test:fixtures`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm typecheck`.
- [ ] Record fixture hashes, dependency lock hash, versions, open debt, and the
  `GO`/`HOLD` decision in `docs/evaluations/g0-decision.md`.
- [x] Keep all M1+ behavior out of the tree until the G0 decision is recorded.
