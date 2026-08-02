# Directory Structure

> How frontend code is organized in this project.

---

## Overview

`apps/memory-workbench-web` is the only browser package. Organize by application boundary first, then feature. Browser code must never import storage, MCP, filesystem, runtime-host, or Node implementation modules.

## Directory Layout

```text
apps/memory-workbench-web/
├── src/
│   ├── api/              # validated HTTP boundary and request coordination
│   ├── app/              # shell, navigation, recovery state, URL policy
│   ├── features/         # feature-owned UI added after the shell stabilizes
│   ├── styles/           # reviewed global visual system
│   ├── main.tsx          # production entry
│   └── mount.tsx         # reusable mount seam for real-browser tests
├── index.html
├── tsconfig.json         # DOM and bundler-only TypeScript boundary
└── vite.config.ts

tests/browser/            # cross-feature real-browser and E2E tests
```

## Module Organization

- Put transport primitives in `src/api`, not in components.
- Put cross-feature navigation, state policy, dialogs, and URL rules in `src/app`.
- Put memory, correction, graph, and health screens under separate `src/features/<name>` directories.
- Keep feature-private components, tests, types, and helpers together.
- Root browser configs own cross-package browser execution; the app package owns browser compilation.

## Naming Conventions

- Use kebab-case for non-component modules and CSS files.
- Use PascalCase for exported React component files only when the component is the file's primary export.
- Use `.test.ts` for Node-safe pure logic and `.browser.test.tsx` for real-browser behavior.

## Examples

- `src/api/client.ts` — validated browser boundary.
- `src/app/recovery-state.ts` — explicit cross-feature policy.
- `src/app/App.tsx` — shell composition without backend ownership.
