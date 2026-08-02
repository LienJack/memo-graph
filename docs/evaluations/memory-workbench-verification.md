# Memory Workbench Verification

## Decision boundary

This report verifies the local Memory Workbench feature surface. It does **not**
change the G6 `NO-GO`, qualify memo-graph for production, validate remote or
multi-user use, or adopt a native Graph backend. Existing G3/G4/G6 evidence is
unchanged.

Result: **PASS for the documented macOS local-experimental envelope.**

## Environment and artifacts

| Item | Verified value |
| --- | --- |
| OS | macOS 15.5 (24F74), arm64 |
| Node.js | 24.18.0 |
| pnpm | 10.33.2 |
| TypeScript | 6.0.3 |
| React | 19.2.8 |
| Vite | 7.3.6 |
| Vitest | 4.1.10 |
| Playwright | 1.62.1 |
| Browser | Playwright Chromium 151.0.7922.34 |
| Baseline before U8 | `c856e38b285e3ab9e3dc7e8d62e537fb6ad598c2` |

The host packages `index.html` plus an exact `.js`, `.css`, and `.woff2` asset
map. The measured production build contains an initial application chunk of
346.61 kB (104.18 kB gzip), a Graph-only Cytoscape chunk of 442.98 kB
(141.98 kB gzip), and 25.92 kB CSS (6.33 kB gzip). Source maps are excluded from
the host package and HTTP allowlist.

## Acceptance matrix

| Example | Requirements | Evidence | Result |
| --- | --- | --- | --- |
| AE1 | R1-R3 startup, navigation, truthful blocked/ready states | Real launcher, operator CLI, authenticated HTTP integration, packaged browser E2E | PASS |
| AE2 | R4-R6, R8 browse, filters, detail, failure distinctions | Workbench contract/storage/service suites and Chromium memory browser suite | PASS |
| AE3 | R7, R9 evidence read-only and edit eligibility | Provenance contract, memory browser, correction-flow browser tests | PASS |
| AE4 | R10-R12 side-effect-free cancel/stale/expiry paths | Correction impact, governance, HTTP, and browser cancel tests | PASS |
| AE5 | R10-R13 immutable commit, receipt replay, convergence | Authenticated HTTP workflow plus real built-browser correction and SQLite reopen | PASS |
| AE6 | R14-R16 bounded Graph and authority labels | Graph contract/storage/integration/security and canvas/semantic browser parity | PASS |
| AE7 | R17 Graph empty/truncated/degraded/failure distinctions | Graph service/browser scenarios and canonical detail navigation | PASS |
| AE8 | R18-R20 authority-first, content-free, read-only health | Health contract, authenticated route, dashboard Chromium tests, DOM control inventory | PASS |

## Cross-boundary evidence

- The real E2E starts a child host from the management launcher, opens the built
  SPA in Chromium, exchanges and removes the fragment ticket, corrects one
  governed memory, inspects Graph, inspects Runtime health, sends `SIGTERM`,
  verifies writer-lease cleanup, reopens SQLite, and reads the durable successor.
- Loopback security tests validate exact `Host`, same-origin/Fetch Metadata,
  bearer and instance binding, one-use ticket/pairing authority, no cookie
  authority, request/body/connection limits, 405 method boundaries, CSP, no
  CORS, exact static assets, and absence of source-map routes.
- Health contracts enforce canonical authority first, one Runtime owner, fixed
  subordinate projection order, explicit observation scope, a future stale
  boundary, deterministic background lanes, and no metrics for unavailable
  observations.
- Health HTTP and E2E assertions prove that memory text, browser bearer, and
  control credentials do not enter the health response. The dashboard contains
  no button, input, select, or textarea and only calls authenticated GET.
- Launcher/recovery tests exercise repeated launch, opener failure, no-open,
  root/config identity mismatch, stale metadata quarantine, active-owner refusal,
  and graceful release without weakening one-writer ownership.
- The visual review artifact is
  `/Users/lienli/.codex/visualizations/2026/08/02/019fc09e-1d86-7ef1-b0a1-86e92aaaec8e/memory-workbench-runtime.png`.
  It was captured from the same real built-host E2E, not from a fixture page.

## Verification runs

| Command or lane | Result |
| --- | --- |
| `pnpm test:web` | PASS — 4 files, 12 tests |
| `pnpm test:web:browser` | PASS — 5 files, 28 tests in real Chromium |
| `pnpm test:web:e2e` | PASS — 1 real-process/built-SPA test |
| Complete Node workbench lane | PASS — 14 files, 55 tests |
| Focused contract, HTTP, launcher, recovery, operator lane | PASS — 6 files, 28 tests |
| Web and root TypeScript checks | PASS |
| Production Runtime/Web/Host build | PASS |
| Full repository ESLint | PASS |
| `pnpm test` project-wide probe | NOT GREEN — 150/159 files passed; see below |

The project-wide probe was allowed to finish. It rejected the changed candidate
against frozen G6 implementation/provenance digests, and the G5 verifier rejected
the then-uncommitted worktree as dirty. Those failures are consistent with the
non-G6 boundary and are not repaired by rewriting historical evidence. Two
resource-heavy tests timed out under four-worker contention and passed when
rerun alone. Two exact projection-status assertions and one U3 private-file
error assertion were updated for their additive contracts and passed. One
unrelated operator governed-secret-admission test still returns
`KEY_UNAVAILABLE` and remains an explicit project-wide red test; it is outside
the workbench surface. `pnpm lint`, `pnpm typecheck`, `pnpm build`, and
`git diff --check` pass on the candidate worktree.

## Residual limitations

- Physical verification is macOS arm64 only. Linux and Windows IPC,
  browser-opening, packaging, and shutdown behavior remain unqualified.
- Authentication is local-loopback and current-OS-user scoped. Hostile same-UID
  processes, remote access, multiple users, and cloud administration are outside
  the threat model.
- The operator CLI has no public `workbench stop` subcommand in v1; verified
  supervisors shut down the identified host with `SIGTERM`.
- Browser E2E uses headless Chromium. The real screenshot supplements component
  accessibility and layout assertions but is not cross-browser qualification.
- Graph is bounded and SQLite-backed. There is no layout persistence, Graph
  relationship editing, native Graph backend adoption, or full raw-evidence
  graph.
- The Runtime dashboard intentionally contains no remediation actions. Operators
  use existing governed CLI/runbook paths outside the browser.
- Recovery-head configuration and existing data-root integrity can place the
  workbench in truthful `health_only` mode; the UI does not bypass recovery
  authority to make content appear available.

## Conclusion

Within the pinned local macOS envelope, the Memory Workbench provides one
authenticated startup path, governed browsing and immutable correction, a
bounded accessible Graph, and an authority-first read-only Runtime dashboard
without creating a second writer or health-content leak. This is feature
verification only; G6 and production readiness remain unchanged.
