# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

Frontend quality gates separate contract/build correctness, pure state logic, and real-browser behavior. A green Node unit lane cannot support accessibility or rendered-layout claims.

## Forbidden Patterns

- Node/storage/MCP/filesystem imports in browser modules.
- `dangerouslySetInnerHTML`, remote executable assets, service workers, or persisted credentials.
- Generic catch-all empty/error screens that erase governance distinctions.
- Runtime Health actions that mutate operational state.
- Automatic mutation replay after timeout, disconnect, expiry, or stale instance.

## Required Patterns

- Abort or supersede obsolete requests and prevent late overwrites.
- Sanitize structural URLs with `replaceState` when disallowed keys appear.
- Label retained stale/degraded/refreshing content and derive mutation availability from recovery policy.
- Provide semantic controls and a non-canvas path for Graph.

## Testing Requirements

- Pure unit tests: schema mismatch, coordinator races, URL allowlist, exhaustive recovery policy.
- Real-browser components: landmarks, navigation, keyboard, focus trap/return, live regions, state actions, narrow reflow, reduced motion, markup-as-text, and URL privacy.
- E2E after host integration: authenticated bootstrap, instance loss, real SQLite browse/correction, Graph bounds, and content-free health.

## Code Review Checklist

- Browser bundles resolve only approved contract subpaths.
- All server/result variants map to distinct UI state and recovery.
- Current authority is never implied for stale or unvalidated content.
- Memory/evidence text cannot create DOM nodes.
- The workflow remains usable at narrow desktop widths, 200% zoom, and without a pointer.
