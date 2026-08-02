# State Management

> How state is managed in this project.

---

## Overview

The workbench uses React local state plus explicit framework-neutral state machines. There is no global state library in v1.

## State Categories

- **Page memory:** free-text search, correction content/reason drafts, dialog state, and unsent intent.
- **Structural URL:** allowlisted view, exact scope, selected governed identifier, and reviewed status switches.
- **Server state:** validated DTOs tied to a bearer and Runtime instance.
- **Recovery state:** a discriminated union carrying retained/stale content only where the recovery matrix permits it.

## When to Use Global State

Promote state only when multiple top-level features need the same live authority and lifecycle. Prefer lifting state to the shell before adding a library. Browser authentication remains in memory and must not enter local/session storage.

## Server State

- Every response is Zod-validated before becoming server state.
- Refresh may retain verified content with an explicit refreshing label and disabled mutations.
- Unauthorized, expired, disconnected, stale-instance, and failed states remove current-authority indicators and stop polling.
- Stale cursor causes a fresh bounded snapshot; mutation loss uses operation recovery and is never blindly replayed.

## Common Mistakes

- Never infer an empty library from blocked, excluded, filtered, or failed responses.
- Never put search text, memory text, reasons, drafts, credentials, or evidence payloads in URL state.
- Never silently rebase a correction draft after stale preview or instance change.
