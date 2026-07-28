# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Workspace, contract ownership, and package boundaries | M0 baseline |
| [Database Guidelines](./database-guidelines.md) | SQLite authority, worker/transaction/recovery contracts | M0 baseline |
| [Error Handling](./error-handling.md) | MCP claims, typed status, and error mapping | M0 baseline |
| [Quality Guidelines](./quality-guidelines.md) | Runtime schemas, canonical hashes, and quality gates | M0 baseline |
| [Logging Guidelines](./logging-guidelines.md) | Structured metadata and memory-content redaction | M0 contract |

---

## Pre-Development Checklist

- Read the task PRD/design/implementation slice.
- Read every backend guide relevant to the changed boundary.
- Search `packages/contracts/src` before defining a payload, enum, identifier,
  or canonical helper.
- Map validation, authority, persistence, projection, and receipt ownership.
- Write/freeze the failing contract or replay case before behavior.

## Quality Check

- Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` under the
  pinned Node runtime.
- Recompute fixture/receipt hashes after intentional payload changes.
- Verify actor/scope/status/tombstone behavior across every touched consumer.
- Check that no memory text, secret, or deleted content enters diagnostics.
- Record Gate versions, lock/fixture hashes, failures, debt, and decision.

---

**Language**: All documentation should be written in **English**.
