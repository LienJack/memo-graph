# Memory Workbench

## Goal and User Value

Provide a local browser workbench that opens from the existing operator entry, makes governed memory understandable and safely correctable, exposes an explainable bounded relationship Graph, and keeps a separate read-only Runtime dashboard. The workbench must preserve the Runtime as the sole authority and must never turn unavailable, blocked, or degraded state into an apparently empty memory library.

The authoritative product and implementation decision artifact is `docs/plans/2026-08-02-001-feat-memory-workbench-plan.md`; this PRD records its observable requirements and acceptance boundary for Trellis execution.

## Confirmed Product Requirements

### Startup and Navigation

- R1. A normal `apps/operator-cli` workbench launch starts or reuses one local host and opens an authenticated browser page unless `--no-open` or headless mode is selected.
- R2. Memory is the default view; Graph and Runtime Health are peer top-level views.
- R3. Startup and reconnection distinguish host unavailable, Runtime unavailable or blocked, browser-open failure, stale session, verified empty data, and ready operation.

### Memory Browsing and Explanation

- R4. Current effective memory is browsable without a query through exact workspace/project and topic grouping axes; topic-scoped memory receives no invented workspace parent.
- R5. Search and filters cover memory layer, lifecycle status, source, and time while non-current records remain visibly separate from the default collection.
- R6. Detail exposes content, kind/layer, lifecycle, exact scope, authority, validity, current revision, provenance, conflicts, and supersession.
- R7. Raw conversation, tool, and other evidence remains read-only and visually distinct from authoritative memory.
- R8. No match, governance exclusion, projection unavailability, authorization failure, and Runtime failure are distinct states.

### Governed Correction

- R9. Only current authoritative and writable memory can enter correction; evidence, history, derived projections, and Graph edges are not directly editable.
- R10. Correction atomically appends required user-feedback provenance and an immutable successor; it never overwrites a prior revision or evidence body.
- R11. Preview shows the diff and proves the complete scope-local canonical descendant closure within one supported hard bound. Display samples may truncate, but an unknown or over-bound canonical set cannot be confirmed.
- R12. Confirmation is explicit, current, single-use, and request-bound. Every exit before acceptance is side-effect free; a lost post-acceptance response recovers by operation identity.
- R13. After acknowledgement the successor is immediately authoritative, all old bounded descendants are ineligible, and projection convergence or failure remains explicit.

### Graph and Health

- R14. Graph uses bounded governed memory, topic, scenario, concept, relation, and projection-source lineage rather than the complete raw evidence graph.
- R15. Graph nodes reach governed detail and bounded read-only provenance expansion.
- R16. Relationship meaning, provenance, and projection status remain visible; derived edges are never represented as independent authority.
- R17. Ready-empty, truncated, stale, rebuilding, degraded, unavailable, and failed Graph states are distinct and retain a route to canonical memory detail.
- R18. Runtime Health leads with canonical authority, then reports Runtime ownership, projections, and background work as subordinate component states.
- R19. Health contains scope, observation time, reason, and action guidance without memory content, evidence payloads, or credentials.
- R20. The first dashboard is read-only and exposes no operational mutation.

## Constraints and Compatibility

- A long-lived managed host is the only owner of SQLite, projections, mutation ordering, browser HTTP, and private MCP IPC.
- Existing direct stdio MCP behavior remains compatible. Managed mode forwards existing MCP framing over authenticated private IPC; it does not silently fall back to a second storage owner.
- SQLite remains canonical. Existing memory hierarchy, governance, lifecycle, recall eligibility, correction, deletion, and invalidation semantics are not redesigned.
- Browser authentication and correction approval are separate capabilities. V1 trusts the current OS user, rejects cross-origin/rebinding/stale-instance access, and uses no port-shared cookie authority.
- Free-text search and drafts never enter URLs. Stable governed IDs and reviewed structural filters may be deep-linked.
- V1 is packaged and physically qualified on macOS. Linux and Windows IPC/browser-opening evidence is deferred.
- Feature completion is not G6 or production qualification.

## Acceptance Criteria

- [ ] AE1: One operator command starts or reuses exactly one host, opens one authenticated Memory page by default, supports no-open/headless use, and reports distinct startup/recovery failures.
- [ ] AE2: A user browses current memory without a query, groups and filters it without invented hierarchy, opens governed detail, and can distinguish all empty/excluded/unavailable/failure states.
- [ ] AE3: Evidence and derived data remain read-only and visually/semantically separate from authoritative memory.
- [ ] AE4: Preview/cancel/expiry/conflict/navigation/failure paths before confirmation acceptance produce zero governed writes and preserve the current-page draft where required.
- [ ] AE5: One accepted correction produces exactly one feedback record, successor, pointer advance, receipt, and complete bounded descendant suppression; replay returns the same receipt and convergence is visible.
- [ ] AE6: Graph opens through an accessible center picker, exposes bounded relation and projection-source lineage with meaning/provenance, and provides an equivalent semantic non-canvas path.
- [ ] AE7: Graph bounds and failure states are truthful, excluded content leaves no client residual, and canonical detail remains reachable when projection health permits it.
- [ ] AE8: The authority-first Runtime Health view distinguishes canonical, Runtime, projection, and background state, remains content-free, and has no accepted or visible write path.
- [ ] Existing direct-mode MCP contract/integration tests remain green; managed mode proves framing parity, stdout purity, one-owner behavior, and credential separation.
- [ ] Real-process loopback, browser, SQLite, replay, recovery, security, accessibility, and macOS lifecycle suites pass with pinned artifacts recorded in the verification report.

## Out of Scope

- Remote access, multi-user collaboration, cloud administration, mobile or desktop-shell clients, and stronger isolation from hostile same-UID processes.
- A graph database, direct Graph editing, Graph layout persistence, user-authored collections, trends, governance queues, or learning-candidate management.
- Runtime Health retry, rebuild, backup, restore, cleanup, rollback, key, or other operational actions.
- Public MCP exposure of every UI-only browse, history, Graph, and preview contract.
- Linux/Windows packaged lifecycle evidence and any claim of G6 or production readiness.

## Planning Status

All user-owned product, UX, compatibility, scope, and risk decisions are resolved in the approved plan. Remaining constants for pagination, Graph bounds, HTTP budgets, IPC paths, browser opening, and polling backoff are implementation-time calibration decisions that may not weaken the observable requirements above.
