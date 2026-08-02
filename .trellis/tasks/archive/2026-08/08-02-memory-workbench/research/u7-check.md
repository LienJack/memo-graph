# U7 Governed Graph Explorer Check

Date: 2026-08-02
Runtime: Node 24.18.0, pnpm 10.33.2, Chromium 151.0.7922.34 (Playwright 1.62.1)

## Delivered vertical slice

- Added strict browser-safe contracts for exact-scope Graph centers, canonical and projection nodes, governed and lineage edges, deterministic bounds, typed unavailable states, and retained/omitted counts.
- Added a read-only SQLite Graph reader and worker/client plumbing. It composes current topic, scenario, procedure, and core projection lineage with current governed relations without granting projection data canonical authority.
- Enforced depth, fan-out, node, and edge ceilings on the server. Returned edges must reference returned nodes, structural identifiers are deterministic, and truncated/degraded/ready-empty outcomes remain distinct.
- Added the authenticated `/api/workbench/graph/query` route and a kernel service boundary that derives principal, allowed scopes, clock, and sensitive-content policy from the active session rather than browser input.
- Added an accessible center picker whose free-text search stays in authenticated request bodies, while stable scope and revision identifiers form the structural deep link.
- Added a synchronized read-only Cytoscape canvas, keyboard-operable semantic node/edge lists, selection detail, projection recentering, and exact canonical-memory navigation.
- Preserved a complete non-canvas path for inspect, select, recenter, and follow-to-detail actions. The canvas owns no mutation, layout persistence, or graph authority.
- Applied the `design-taste-frontend` performance boundary by loading Cytoscape only after Graph renders; Memory and Runtime routes do not pay the graph-engine cost on first load.

## Findings fixed

- The first authenticated integration assumed a canonical node would sort first. Graph nodes are now tested as deterministic but order-independent semantic membership.
- A sensitive fixture initially attempted an active admission, which governance correctly rejected. The residual test now uses the required quarantine decision and proves the browser read returns a uniform not-found result with no content.
- Relation descriptions were initially filtered only when their neighbor node was unavailable. The SQL now excludes secret and session-disallowed sensitive projection lineage and relation rows before descriptions or edge metadata can enter the Graph response.
- The first Cytoscape integration added about 444 kB to the initial application chunk. Dynamic loading reduced the initial JS bundle from 777.85 kB to 333.92 kB; the 442.98 kB graph engine is now a separate Graph-only chunk.
- Static analysis found union states that tests had not explicitly narrowed and four non-null assertions in request assembly. Explicit status branches and local structural-state captures now satisfy the root type and lint gates.
- Cytoscape lifecycle loading is cancellation-aware: an unmounted or remounted component cannot attach a late instance, and every mounted instance is destroyed during cleanup.

## Verification

- Runtime build: pass.
- Focused contract/service/SQLite/HTTP/security suite: 6 files, 24 tests passed, including exact-scope authority, graph bounds, projection lineage, governed relations, sensitive center exclusion, sensitive relation-description residuals, authenticated routing, and finite HTTP boundaries.
- Real Chromium browser tests: 4 files, 25 tests passed, including keyboard center selection, URL search privacy, canvas/semantic parity, projection recentering, canonical detail navigation, and all existing memory/correction flows.
- Pure frontend unit tests: 4 files, 11 tests passed.
- Web typecheck: pass.
- Root TypeScript check: pass.
- Production Vite build: pass; initial JS 333.92 kB / 100.38 kB gzip and lazy Graph chunk 442.98 kB / 141.98 kB gzip.
- Full repository ESLint: pass.
- `git diff --check`: pass.

## Release boundary

U7 proves the bounded Graph API and accessible explorer through real SQLite, authenticated HTTP, content-residual security, and Chromium component boundaries. U8 still owns the read-only Runtime dashboard, serving the built SPA from the secure host, packaged startup behavior, built-host E2E, operator documentation, and refreshed release evidence. Existing frozen G6 evidence remains intentionally unchanged until that release boundary is handled.
