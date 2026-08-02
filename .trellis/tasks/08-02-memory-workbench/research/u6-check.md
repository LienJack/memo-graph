# U6 Memory and Correction UI Check

Date: 2026-08-02
Runtime: Node 24.18.0, pnpm 10.33.2, Chromium 151.0.7922.34 (Playwright 1.62.1)

## Delivered vertical slice

- Connected the authenticated browser session to governed list, exact-revision detail, correction preview, and correction confirmation routes owned by the managed Runtime session.
- Added current-effective browsing, body-only search, exact-scope peer grouping, persistent observed scope options, explicit non-current filtering, bounded pagination, and structural deep links containing only governed scope, memory, and revision identifiers.
- Added authoritative detail with lifecycle, validity, conflict/projection status, immutable revision history, and bounded provenance nodes that preserve redacted or unavailable sources as typed gaps.
- Added a local correction draft with required reason, sealed old/new preview, canonical closure count/hash/sample boundary, explicit focus-trapped confirmation, mutation receipt, successor navigation, and bounded projection-convergence polling.
- Kept historical revisions, evidence, provenance nodes, derived data, Graph, and dashboard surfaces read-only. Dirty drafts are guarded on selection and top-level navigation; explicit discard is write-free.
- Preserved drafts on stale preview or conflict, ignored superseded reads, and allowed the same sealed preview to recover an accepted commit after a lost response.
- Applied the `design-taste-frontend` visual baseline: local Geist families, restrained dark surfaces, high-contrast status hierarchy, explicit responsive reflow, transform/opacity-only motion, and reduced-motion handling.

## Findings fixed

- The first browser fixture imported the contracts root and pulled Node `crypto` into the production bundle. Browser code now uses explicit browser-safe `workbench` and `workbench-host` package exports; the Vite production build contains no Node implementation module.
- Dynamic confirmation timestamps made an identical lost-response retry hash differently and return `CONFLICT`. The approval registry now freezes the first confirmation timestamp, so concurrent or repeated confirmation uses the same storage request and returns the existing receipt.
- A historical row initially selected only `memory_id`, which silently reopened the current revision and exposed correction. Selection and deep links now carry the governed `revision_id`; historical detail is proven read-only in Chromium.
- Exact-scope filtering initially removed other discovered peer scopes from the selector. The page now retains already-authorized observed options for the session without inventing parent scopes.
- Commit-driven URL updates initially raced and cancelled convergence polling. Polling now resolves the successor first, then publishes the structural deep link; loading generations prevent obsolete requests from clearing current progress.
- The correction HTTP budget initially counted bytes as though the 256,000-character contract were ASCII. The preview route now has a finite 2 MiB cap that covers worst-case valid JSON encoding while other routes remain at 8 KiB.
- The first post-commit form briefly remained dirty against the old revision. Receipt state now closes the draft, disables further edits until successor detail arrives, and retains the committed reason beside the receipt.

## Verification

- Runtime build: pass.
- Governed service/HTTP/SQLite suite: 4 files, 14 tests passed, including authenticated list/detail, write-free preview, atomic successor, exact receipt replay, stale competing revision, body bounds, and route authority.
- Pure frontend unit tests: 4 files, 10 tests passed.
- Real Chromium browser tests: 3 files, 22 tests passed, including peer grouping, exact historical selection, provenance gaps, URL privacy, text-only rendering, obsolete-response cancellation, stale-draft retention, navigation guard, confirmation focus, lost-response recovery, receipt context, and successor deep link.
- Web typecheck: pass.
- Root TypeScript check: pass.
- Production Vite build: pass; 317.24 kB JS / 95.79 kB gzip, with locally bundled fonts and no Node `crypto` import.
- Full repository ESLint: pass.
- `git diff --check`: pass.

## Release boundary

U6 proves AE2-AE5 through the managed host and a real SQLite fixture, plus the primary workflow in real Chromium component tests. U7 still owns the bounded Graph API/explorer. U8 still owns serving the built SPA from the secure host, the read-only Runtime dashboard, packaged startup behavior, and refreshed release evidence. Existing frozen G6 evidence is intentionally unchanged until U8.
