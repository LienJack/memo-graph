# Memory Workbench Implementation Plan

## Source and Execution Posture

Execute `docs/plans/2026-08-02-001-feat-memory-workbench-plan.md` on branch `codex/memory-workbench`. Preserve U1-U8 identifiers in task tracking and commits. Characterization-first and test-first notes below are mandatory; the plan body remains unchanged during execution except for its final `status: active` to `completed` transition at shipping.

## Ordered Units

- [x] Baseline: record HEAD, validate the Trellis task, run current contract/governance/MCP/Graph/health lanes, and record any pre-existing failure before product edits.
- [x] U1 — Governed read contracts and queries (characterization-first): freeze recall eligibility/history/provenance behavior; add browser-safe DTOs, deterministic exact-scope reads, bounded snapshot pagination, and typed failure distinctions; verify AE2/AE3 through the service.
- [x] U2 — Sealed correction preview and atomic provenance (test-first): prove all pre-confirmation exits are write-free; implement the shared hard closure bound, required reason, sealed preview, single-use approval, atomic successor/feedback/suppression/receipt transaction, and lost-response replay; verify AE4/AE5 and MCP compatibility.
- [x] U5 — Frontend foundation (fixture-first, allowed after U1 contracts): add isolated React/Vite/TypeScript tooling, typed API validation, explicit recovery-state model, accessible shell, structural URL allowlist, and real-browser component harness; do not wire mutations yet.
- [x] U3 — Runtime host and MCP attach proxy (characterization-first): extract transport-neutral composition, prove existing MCP framing over private IPC, implement authenticated instance/root/config handshake, bounded snapshot registry, managed background supervisor, direct-mode compatibility, stdout purity, and one-owner recovery. Stale endpoint arbitration remains explicitly in U4, where the per-root launch lock and authenticated liveness probe exist.
- [x] U4 — Secure loopback host and operator launcher (adversarial tests first): add the existing operator CLI workbench command, per-root startup arbitration, finite HTTP budgets, one-use ticket/pairing recovery, strict loopback boundary, static fixture, no-open mode, and graceful lifecycle. Evidence: `research/u4-check.md`.
- [x] U6 — Memory and correction UI (state/cancel tests first): deliver browse, peer grouping axes, search/filter, governed detail/history/provenance, required-reason draft, diff/impact preview, explicit confirmation, receipt recovery, and projection convergence.
- [x] U7 — Governed Graph backend and accessible explorer (bounds/semantic path first): add exact-scope relation/projection-source Graph contracts and reads, accessible center picker, bounded expansion, semantic list/detail, Cytoscape lifecycle adapter, truthful degradation, and content-residual checks. Evidence: `research/u7-check.md`.
- [x] U8 — Authority-first Health, packaging, and evidence (real processes): add content-free health aggregation and hierarchy, integrate built web assets into the host, document operator workflows, run AE1-AE8 plus security/recovery/accessibility/parity matrices, and record macOS verification without claiming G6. Evidence: `research/u8-check.md`.
- [ ] Quality and shipping: simplify at unit-cluster boundaries, run project-wide checks, perform correctness/security/API/reliability/testing review, resolve findings, update Trellis specs, commit final evidence, archive the task, and mark the plan completed.

## Dependencies and Gates

- U1 precedes U2, U3, U5, and U7 contracts.
- U2 and U3 precede U4; U2 and U4 security suites must pass before HTTP correction is enabled.
- U2, U4, and U5 precede U6.
- U1, U4, U5, and U6 precede U7.
- U3-U7 precede U8 and full built-SPA verification.
- The existing-MCP-framing characterization is a gate before designing any fallback operation RPC.
- An over-bound or unknown canonical invalidation closure is a release-blocking rejection path, never a confirmable degraded state.

## Primary Validation Lanes

Run focused tests after every unit, then the broad repository gates under the pinned Node/pnpm environment:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Add and run focused lanes for contract, storage, governance/replay, MCP/direct and managed parity, host integration, recovery, loopback security, browser components, Playwright E2E, Graph residuals/bounds, and Runtime Health route/read-only behavior. Lifecycle and credential claims require isolated temporary roots and real child processes; accessibility/focus/layout claims require a real browser.

## Risky Boundaries and Rollback Points

- Before U2 commit: verify no test path can partially append feedback, successor, pointer, suppression, or receipt.
- Before U3/U4 integration: preserve a green direct MCP characterization commit and ensure runtime-host does not import `mcp-server`.
- Before enabling correction HTTP: preserve a green static-host security commit with slow-client/flood/pairing/rebinding coverage.
- Before U7: verify Graph DTOs cannot expose purged, hidden, or unauthorized content and projection lineage is never authoritative.
- Before U8: keep frontend build integration reversible from host lifecycle and record all residual platform limitations.

## Final Review Gates

- Every R1-R20 requirement maps to at least one passing AE or explicit regression test.
- No URL, descriptor, log, DOM residual, response header, or health payload contains a credential or unnecessary memory/evidence content.
- One-writer, correction atomicity/replay, scope-local invalidation, current-only default browse, Graph bounds, and dashboard read-only invariants are proven across real boundaries.
- Existing direct MCP behavior remains green, managed parity is recorded, and macOS packaging evidence names exact versions and artifacts.
- `docs/evaluations/memory-workbench-verification.md` states that this is workbench evidence, not G6 or production qualification.
