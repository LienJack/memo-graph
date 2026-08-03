# Hook Guidelines

> How hooks are used in this project.

---

## Overview

Use React hooks for component lifecycle and current-page UI state. Transport and concurrency semantics remain framework-neutral classes/functions so they can be tested without a simulated DOM.

## Custom Hook Patterns

- Extract a custom hook only when stateful behavior is reused or has a lifecycle contract that is clearer in isolation.
- Return explicit state and intent callbacks; do not expose mutable refs as public state.
- Effects must clean up listeners, polling, AbortControllers, and focus ownership.

## Data Fetching

V1 uses the typed `WorkbenchApiClient` plus `RequestCoordinator`. A new structural filter or route cancels the old request, and late responses are ignored. Do not add a server-state library until bounded polling and recovery requirements prove it necessary.

## Naming Conventions

Custom hooks use the `use` prefix. Framework-neutral request/state modules do not.

## Common Mistakes

- Do not capture a stale bearer, instance ID, or draft in a long-lived effect.
- Do not automatically replay a mutation after connection or instance loss.
- Do not poll when recovery policy says `stop`.
