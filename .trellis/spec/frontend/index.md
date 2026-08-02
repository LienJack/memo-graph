# Frontend Development Guidelines

> Project-specific conventions for the Memo Graph browser workbench.

---

## Overview

The browser application is an isolated React/Vite workspace package. It consumes browser-safe contract subpaths, treats Runtime responses as untrusted until Zod validation succeeds, and keeps authority and recovery state explicit in the UI.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Active |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Active |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | Active |
| [State Management](./state-management.md) | Local state, URL state, server state | Active |
| [Quality Guidelines](./quality-guidelines.md) | Code standards and testing | Active |
| [Type Safety](./type-safety.md) | Type and validation boundaries | Active |

## Pre-Development Checklist

1. Read this index and every linked guide before changing the web application.
2. Confirm every imported contract entry point has no `node:` dependency in its emitted module graph.
3. Name every new server/recovery state and define its retained-content, mutation, recovery, focus, and polling policy.
4. Keep free text and drafts out of URLs, browser storage, logs, and referrers.

## Quality Check

Run browser-package typecheck, build, unit tests, scoped ESLint, and the real Chromium browser lane. DOM, focus, keyboard, layout, and accessibility claims cannot be proven by Node-only tests.

**Language**: All documentation should be written in **English**.
