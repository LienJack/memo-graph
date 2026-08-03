# Type Safety

> Type safety patterns in this project.

---

## Overview

Browser TypeScript is strict, DOM-scoped, and compiled with bundler resolution. Static types do not replace validation at the HTTP boundary.

## Type Organization

- Browser-safe wire schemas and inferred DTOs live in `@memo-graph/contracts/workbench`.
- Feature-only props and state live next to the owning component/module.
- Cross-feature recovery and URL types live under `src/app`.
- Do not import the contracts root from browser code; it includes Node-only utilities.

## Validation

Use Zod `.safeParse` for every network response and fail with `INVALID_RESPONSE` without exposing unvalidated content. Request DTOs use the contract input type; response DTOs come only from parsed schema output.

## Common Patterns

- Use discriminated unions and exhaustive `switch` statements for recovery and result states.
- Use `import type` under `verbatimModuleSyntax`.
- Keep `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` enabled.

## Forbidden Patterns

- No explicit `any`, non-null assertions, unchecked response casts, or Node globals in the app.
- No duplicate browser DTOs that can drift from the contract package.
- A package subpath is not browser-safe merely because its public types look safe; verify its emitted runtime import graph contains no `node:` modules.
