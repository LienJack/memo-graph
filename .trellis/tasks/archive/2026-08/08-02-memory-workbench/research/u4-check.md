# U4 Secure Loopback Host and Launcher Check

## Delivered boundary

- Added `@memo-graph/memory-workbench-host`, a managed host that composes the U3 Runtime owner with an ephemeral `127.0.0.1` HTTP origin and a health-only fallback.
- Added private, atomically published endpoint/control artifacts keyed by full root and Runtime-config identities.
- Added a per-root launch lock, authenticated liveness reuse, bounded startup wait, stale artifact quarantine, active-owner protection, and real child-process shutdown cleanup.
- Added one-use fragment tickets, TTY-only pairing recovery, in-memory browser bearers, HMAC-authenticated operator control, nonce replay rejection, and instance binding.
- Added strict Host/origin/Fetch Metadata checks, route/static allowlists, finite body/header/request/connection/rate/concurrency budgets, no-store/CSP/frame/MIME/referrer/CORP headers, and health-only content rejection.
- Added `memo-graph-operator workbench` with `--no-open` and `--headless`. Machine-readable output contains only non-secret launch metadata; pairing codes are rendered only to an interactive TTY.
- Kept the workbench configuration optional in the existing operator schema. The exact U3 `MemoryServerConfigSchema` validates it only when the workbench command executes, preserving old operator-config output and unrelated command behavior.

## Review findings resolved

- Startup health initially sampled the recovery authority while its first writer-queue anchor was still in flight, permanently misclassifying a healthy Runtime as `health_only`. Endpoint publication now waits only for bounded in-flight startup work and remains health-only for a stable blocked status.
- The initial launcher draft fabricated ticket expiry. The child now returns the exact in-memory authority expiry in its private ready message.
- Browser-open failure originally lost the only recovery authority. It now mints a fresh short-lived pairing code and returns only the base origin.
- Temporary launch configuration was initially removed by pathname. Cleanup now uses the atomically published file identity and cannot unlink a replacement.
- Stale Runtime descriptor paths were initially checked only by basename. Credential and socket paths now have exact deterministic allowlists, including the U3 long-path fallback; forged paths fail closed and their targets are untouched.
- Control bootstrap and browser bootstrap now have independent rate windows, and nonce eviction is ordered by expiry rather than lexical nonce value.
- A transient child stderr stream can no longer block readiness; output is drained under a fixed byte budget.

## Passing verification

Pinned environment: Node `24.18.0`, pnpm `10.33.2`.

```text
pnpm exec vitest run \
  tests/integration/operator-workbench.integration.test.ts \
  tests/security/workbench-http-boundary.test.ts \
  tests/integration/workbench-host-launch.integration.test.ts \
  tests/recovery/workbench-launcher.recovery.test.ts

4 files, 18 tests passed
```

The real-process tests prove one owner under concurrent launch, matching-instance reuse, one-use ticket replay rejection, no browser call in no-open mode, safe opener-failure pairing, crash-remnant replacement, stale-lock recovery, active Runtime preservation, identity mismatch refusal, and forged artifact-path refusal.

```text
pnpm typecheck
pnpm lint
git diff --check

passed
```

The U3 compatibility sample remained green:

```text
tests/recovery/workbench-lifecycle.recovery.test.ts
tests/mcp/managed-host-proxy.integration.test.ts
tests/mcp/direct-mode-characterization.integration.test.ts
tests/integration/operator-destructive-confirmation.integration.test.ts

4 files, 28 tests passed
```

## Frozen-release boundary

The broader sample also ran `tests/fixtures/g6.fixture.test.ts` and `tests/integration/operator-cli.integration.test.ts`. It produced 50 passes and four expected frozen-release failures: three G6 fixture assertions reject the changed tested-implementation digest, and the production secret-admission case rejects the same now-stale pinned Runtime identity as `KEY_UNAVAILABLE`. U4 does not rewrite or requalify G6 evidence. U8 owns the explicit workbench verification artifact and must continue to state that it is not a G6 production qualification.

## Deferred to later units

- U6 wires governed memory reads and sealed corrections to authenticated HTTP routes.
- U7 adds bounded governed Graph reads and the accessible explorer.
- U8 serves the built SPA instead of the local static fixture, expands authority-first health, documents installation/operation, and runs the full AE matrix.
