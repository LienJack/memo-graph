# U8 Health, Packaging, and Release-Evidence Check

Date: 2026-08-02
Runtime: Node 24.18.0, pnpm 10.33.2, macOS 15.5 arm64, Playwright Chromium 151.0.7922.34

## Delivered vertical slice

- Added a strict content-free health contract with canonical authority, Runtime
  ownership, fixed subordinate projection order, background aggregation,
  deterministic lanes, observation scope/time, reason, guidance, and stale
  boundary.
- Composed that contract from real canonical storage health, managed Runtime
  lifecycle, background supervisor observations, and Graph projection status.
- Added an authority-first Runtime dashboard. Canonical storage is the primary
  card; Runtime, projections, and background work are visibly subordinate and
  independently healthy, lagging, degraded, failed, or unavailable.
- Kept the dashboard read-only. It performs authenticated GET polling and has no
  retry, rebuild, backup, restore, cleanup, rollback, key, form, or button
  surface.
- Replaced the U4 fixture at the real host boundary with the built SPA. Startup
  exchanges a one-use fragment ticket, removes it from history immediately, and
  falls back to a DOM-safe pairing gate.
- Added an in-memory static asset allowlist for `.js`, `.css`, and `.woff2`, with
  no remote asset, inline script, source-map route, symlink, invalid filename,
  oversized file, or fallback fixture path in packaged mode.
- Added a real process/browser/SQLite E2E and a root `test:web:e2e` command. The
  E2E corrects a memory, inspects Graph and Health, shuts down the child,
  verifies writer-lease cleanup, and reopens the durable successor.
- Documented startup/reuse, TTY pairing, blocked mode, credentials, stale
  recovery, process lifetime, residual platform limits, and the explicit
  non-G6 boundary.

## Findings fixed

- Native browser `fetch` was stored unbound and failed in Chromium with
  `Illegal invocation`; the client now binds the default implementation to
  `globalThis`.
- The launcher closed a piped child stderr after readiness. A later SIGTERM
  shutdown diagnostic hit `EPIPE` before root-lease release. Managed background
  children now ignore stderr from spawn while direct host execution retains its
  diagnostics.
- Packaged mode still served the U4 `/bootstrap.js` and `/fixture.css` paths.
  Those paths are now available only in fixture mode; packaged mode serves only
  its exact asset map.
- Instance identity was safe in normal callers but not enforced at the HTTP
  constructor. The server now rejects identities that could escape the HTML
  attribute boundary.
- Observation scope was initially descriptive only. The result contract now
  enforces canonical-root, current-Runtime-instance, and configured-scope
  placement for the corresponding authority planes.
- The Runtime dashboard originally risked interpreting a missing first response
  as healthy. It renders no health cards until one trusted observation exists
  and visibly marks retained observations stale after failure/expiry.
- U3 added durable retrying/terminal projection counters and a generic private
  descriptor reader; three stale exact assertions were updated and now pass.

## Verification

- Complete Node workbench lane: 14 files, 55 tests passed, including a real
  child host and built-SPA E2E.
- Real Chromium component lane: 5 files, 28 tests passed.
- Pure frontend unit lane: 4 files, 12 tests passed.
- Focused contract/security/lifecycle matrix: 6 files, 28 tests passed.
- Health/static-boundary contract and security lane: 2 files, 17 tests passed.
- U3 additive status assertion repairs: 2 files, 10 tests passed; private-file
  assertion repair: 1 file, 3 tests passed.
- Resource-heavy replay and recovery tests that timed out in the full parallel
  run both passed alone.
- Root TypeScript, web TypeScript, ESLint, production Runtime build, production
  web/host build, and `git diff --check`: pass.
- Clean-tree G5 artifact integrity after commit `ffd6d22`: 1 file, 4 tests
  passed; the earlier dirty-path rejection is closed.
- Production bundle: initial JS 346.61 kB / 104.18 kB gzip; lazy Graph chunk
  442.98 kB / 141.98 kB gzip; CSS 25.92 kB / 6.33 kB gzip.
- Visual review used the real built-host screenshot at
  `/Users/lienli/.codex/visualizations/2026/08/02/019fc09e-1d86-7ef1-b0a1-86e92aaaec8e/memory-workbench-runtime.png`.

## Project-wide gate boundary

The completed `pnpm test` probe passed 150 of 159 files and 773 tests, with 12
failures. The failures were classified rather than hidden:

- frozen G6 implementation/provenance checks reject the changed candidate, as
  they must until a separate requalification; historical G6 evidence was not
  rewritten;
- the G5 verifier rejected uncommitted workbench paths as dirty and is rerun
  after the feature commit;
- two four-worker timeouts passed alone;
- three additive assertion drifts were fixed and passed;
- one unrelated operator governed-secret-admission test still fails with
  `KEY_UNAVAILABLE` and remains recorded rather than being changed inside U8.

This means the workbench-specific acceptance surface is green, but the
repository-wide `pnpm test` command is not claimed green.

## Release boundary

AE1-AE8 pass for the documented local macOS experimental envelope. This check
does not change the G6 `NO-GO`, claim production readiness, qualify Linux or
Windows, expand beyond current-OS-user trust, adopt a native Graph backend, or
add operational browser mutations.
