# Memory Workbench Technical Design

## Decision Authority

`docs/plans/2026-08-02-001-feat-memory-workbench-plan.md` is the complete reviewed design artifact. This file maps its boundaries into the Trellis task and does not replace it.

## Architecture and Ownership

The managed path has one long-lived Runtime host. `apps/operator-cli` owns the public workbench lifecycle; `apps/memory-workbench-host` owns secure loopback HTTP and process lifecycle; `packages/runtime-host` owns transport-neutral composition, startup arbitration, snapshot/session registries, private IPC, and background supervision. Browser and MCP clients never open the managed data root directly.

Dependency direction is acyclic:

1. `packages/contracts` owns browser-safe Zod DTOs and stable error/state vocabulary.
2. `packages/storage-sqlite` owns deterministic governed queries and atomic persistence behind the worker protocol.
3. `packages/memory-kernel` owns governed workbench operations and approval semantics.
4. `packages/runtime-host` composes concrete Runtime lifecycle services without importing `mcp-server`.
5. MCP and application adapters depend inward on the host/service boundary.

## Core Data Flows

### Startup and Browser Authority

The operator command acquires a per-root bootstrap lock, reuses only an authenticated matching host, or starts a new owner in dependency order. The host atomically publishes non-secret instance metadata only after readiness. A one-use fragment ticket exchanges for a short-lived per-page bearer and is removed immediately; manual recovery uses a short-lived TTY pairing code. Base URLs, logs, descriptors, argv after the launch handoff, environment variables, and browser storage contain no reusable credentials.

### Browsing

The workbench service returns current governed memory by default. Exact workspace/project and topic scopes are peer grouping axes. Bounded server-side membership snapshots make pagination stable without holding SQLite transactions across requests. Expiry, eviction, restart, or incompatible frontier produces `stale_cursor` rather than continuing against changed membership.

### Correction

The browser keeps replacement content and required reason as one current-page draft. Preview performs no write, proves the complete scope-local descendant closure within the shared hard bound, and seals target revision, normalized request, relevant frontiers, session, expiry, and operation identity. Explicit confirmation issues one single-use approval. One canonical transaction appends feedback evidence and successor, advances the pointer, suppresses the complete revalidated descendant set, records the receipt, and creates pending projection work. Pre-acceptance disconnect is side-effect free; post-acceptance response loss resolves by operation identity.

### Graph

The governed Graph read model combines current accepted relation rows with projection membership and `derived_from` lineage from `projection_revision_sources` inside exact scope. Projection nodes come from real topic/scenario/core payloads. No cross-scope hierarchy is invented. Bounds apply to nodes, edges, depth, fan-out, payload, and expansion. Cytoscape is a visual layer synchronized with a semantic list and detail panel.

### Health and Background Work

One managed supervisor drains configured consolidation, FTS, Graph, and vector jobs with bounded concurrency, retry/backoff, terminal failure, restart recovery, health publication, and graceful drain. Health aggregation is content-free and authority-first: canonical state is primary; Runtime ownership, projections, and background work are subordinate observations. Missing and stale observations are not healthy.

## Security and Reliability Boundary

- Bind only the `127.0.0.1` literal on an ephemeral port; validate one canonical Host plus exact Origin and Fetch Metadata; expose no CORS.
- Enforce finite header/body/time/connection limits, global and per-session concurrency, bounded queues, cancellation, and reserved IPC/mutation/health capacity.
- Use local bundled assets, restrictive CSP and response headers, no service worker, no trusted HTML, and `no-store` throughout.
- Separate browser, IPC, approval, preview, and operation identities. Restart revokes all instance-bound authority.
- Managed MCP reuses current framing over authenticated private IPC and terminates in the existing adapter. A second operation protocol is allowed only after a recorded characterization proves a required lifecycle semantic cannot be preserved.

## UI State and Accessibility

All Memory, Graph, and Health features use the shared recovery matrix: loading, refreshing, ready-empty, filtered-empty, governance-excluded, truncated, degraded, blocked, unauthorized/expired, disconnected/stale, and failed. Each state defines retained content, mutation availability, recovery action, polling behavior, and focus target.

The UI must reflow in a narrow desktop window and at 200% zoom. Keyboard access, semantic headings/controls, focus trap and restoration, restrained live regions, reduced motion, target size, readable contrast, and a complete non-canvas Graph workflow are release requirements.

## Compatibility, Rollback, and Platform

Direct stdio MCP remains available and behaviorally unchanged. Managed mode is explicit and fails closed when the host is unavailable. The v1 physical target is macOS, with narrow IPC and opener seams retained for later platforms.

Each implementation unit is committed only after its focused tests pass. A unit can be reverted independently until the cross-layer host integration begins. Runtime composition and MCP proxy changes require direct-mode characterization and a managed parity gate before release. Schema changes remain additive; rollback must not require rewriting existing memory or evidence.

## Implementation-Time Calibration

Conservative defaults for list pages, snapshot count/bytes/TTL, Graph node/edge/depth/fan-out limits, HTTP resource/fairness budgets, IPC path, shell-free browser opener, and polling backoff are selected from representative fixtures and adversarial tests. Any result that changes product behavior or authority boundaries returns to planning review.
