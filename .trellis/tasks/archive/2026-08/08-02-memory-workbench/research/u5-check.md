# U5 Frontend Foundation Check

Date: 2026-08-02
Runtime: Node 24.18.0, pnpm 10.33.2, Chromium 151.0.7922.34 (Playwright 1.62.1)

## Findings fixed

- The first shell draft kept the sidebar label `current instance verified` in blocked, unauthorized, expired, disconnected, stale-instance, and failed states. The shell now derives the authority indicator from the recovery discriminant, removes the verified indicator in those states, marks retained content as stale context, disables mutation capability, and stops polling through the shared policy.
- The initial browser contract entry imported Node-backed schema modules transitively. The package now exposes `@memo-graph/contracts/workbench`; shared `EvidenceSourceSchema` and `MutationReceiptSchema` live in browser-safe modules, and the built Workbench import graph contains no `node:` import.
- Recovery announcements initially wrapped interactive controls in `role=status`. Only the message region now owns the live status role.

## Verification

- Browser-safe contracts build: pass.
- Contract regressions: 2 files, 15 tests passed (`workbench`, `receipts`).
- Web typecheck: pass.
- Browser-test typecheck: pass.
- Production Vite build: pass; 34 modules, 209.13 kB JS / 66.55 kB gzip.
- Pure frontend unit tests: 4 files, 9 tests passed.
- Real Chromium browser tests: 1 file, 11 tests passed, including three peer views, seven recovery fixtures, focus restoration, URL privacy, markup-as-text, narrow reflow, and 44px targets.
- Scoped ESLint: pass.
- Root `pnpm typecheck`: pass.
- Root `pnpm lint`: pass.
- `git diff --check`: pass.
- Rendered 1440x960 shell inspected at `/Users/lienli/.codex/visualizations/2026/08/02/019fc09e-1d86-7ef1-b0a1-86e92aaaec8e/memory-workbench-u5.png`.

## Review limitation

Three independent check-agent dispatches were attempted but did not return findings before being stopped. The evidence above is from reproducible main-thread gates and direct rendered-output inspection; it is not represented as an independent reviewer result.
