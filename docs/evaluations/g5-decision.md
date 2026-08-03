# G5 Governed Learning Decision

Status: **GO for the exact local synthetic release path**

Decision date: 2026-07-30

## Decision

Accept the governed M5 learning-release mechanism for the one frozen
exact-scope retrieval-policy candidate exercised by G5. The decision is
strictly bound to:

- tested implementation
  `91d810efe17632e64f5e9a3ddae81f8e9f0b9985`, tree
  `34719539c098343b3d47771cb0588be905faf6c5`;
- evidence commit
  `b9c0907745cedf3315d7ab3f42a39c9afb8790eb`;
- dependency lock
  `sha256:89b71c57b48310cd99dee5a054be88d08c8af18363b465f8dca2a98b186c5f82`;
- migration set
  `sha256:842ed0336266bd9a4ca7a740654671d021d1dff0bc294361b6ea9a5b17fb35b9`;
- G5 manifest
  `sha256:12fe4d89de233dbe43ae3e1c416ca58a1e07684ed9602085416e2e40db6c6fac`;
- independent verification report
  `sha256:8b8d41bd2242efd065ec7cb96528d8278b31cfaff37e3498799546311317e82f`.

Every verifier-backed hard rule is true. There is no first false hard rule.
The verifier reports `ELIGIBLE_FOR_U9`, the required review reports zero
unresolved P0/P1 findings, and the full repository gates pass.

This GO does not enable automatic publication. It accepts only the exact
authority, canary, release, monitor, pause, and rollback path demonstrated by
the evidence. New candidate types, wider scopes, changed retrieval topology,
changed thresholds, changed fixtures, changed executable identity, or
production traffic require new evidence and a new decision.

## Exact release and fallback

The accepted release slot is
`sha256:634ed733beb2ce00f30f9da0297e2f9dfd1f135ac7a8c10e6962dca144bd109f`.
The only G5-qualified candidate/release pair is:

- candidate: `candidate_storage_1`;
- learned release:
  `release:a8f7214a0c8a8db3b5f2515649b06c0ffc855ab68`;
- learned configuration:
  `sha256:1e4f2868b9500ad514217fc1ad872ab2f1b95bed53cd40cba41c1d2e0dc76db8`;
- release receipt:
  `release-receipt:8b360c8ffef8ca5a6a397957bd0d813ba8859f9ed`;
- release pointer revision: `1`.

The accepted prior/base release is `null`, with base configuration
`sha256:64929db139aa201583787758847a1da09e0c26bc1a2d879c0851201237a2a265`.
The exact rollback is:

- rollback release:
  `rollback:9e3bfbc0103b26085642e2dfa2b86843f4ac8fdca`;
- rollback receipt:
  `rollback-receipt:831a8f81d9d43bc5002d73ed97103fc66f2c0080a`;
- restored release: `null`;
- restored pointer revision: `2`;
- restored pointer:
  `sha256:de5c3c21837c0ef5d039ba28cb84d3838113d01028c29c2573a864b1fe296126`.

The synthetic test database intentionally ends on the restored base pointer
after a forced monitor mismatch and authorized rollback. That terminal state
is rollback evidence, not a G5 failure. No production database or production
traffic exists in this decision, so this document does not claim that a
production pointer was moved.

## Gate result

| Gate dimension | Result | Evidence |
| --- | --- | --- |
| Frozen identity | Pass | Commit, tree, lock, migrations, runtime, corpus, partitions, scorers, thresholds, seed, and accepted retrieval topology are hash-bound. |
| Three-arm quality | Pass | `no_candidate`, `current`, and `candidate` share one common identity; every D5 partition rule passes. |
| Negative transfer | Pass | The harmful calibration-only candidate is rejected with zero pointer change. |
| Authority | Pass | Canary authorization and post-canary release approval are distinct, exact, and single-use; a precomputed circular approval is rejected. |
| Canary | Pass | Three hidden independent exposures complete inside the bound; a forced timeout aborts terminally with zero pointer effect. |
| Release and recovery | Pass | Release, idempotent replay, monitor success/breach, pause, authorized rollback while paused, resume, and no-resurrection are linked by durable receipts. |
| Governance and privacy | Pass | Exact scope and principal controls remain in force; graph/vector remain disabled; reports contain no production claim. |
| Resource evidence | Pass for the frozen local harness | All required metric families are measured separately; wall-clock observations are not product SLOs. |
| Code and repository quality | Pass | 98 test files passed, 481 tests passed, 6 skipped; lint, typecheck, build, high-level audit, focused artifact integrity, and independent evidence verification passed. |

## Unchanged decisions and controls

- SQLite remains the sole canonical authority.
- G4A remains `NO-GO`; SQLite relations remain active and graph is disabled.
- G4B remains `NO-GO`; FTS5, recency, layered projections, and SQLite
  relations remain active and vector is disabled.
- Learned policy may only narrow the configured operator policy. It cannot
  weaken authority, lifecycle, tombstone, purge, conflict, scope, privacy, or
  Context-budget rules.
- Learning remains candidate-only by default. Publication requires a fresh
  exact approval and pointer compare-and-swap.
- `learning_pause`, `learning_resume`, exact monitor receipts, and authorized
  rollback remain mandatory controls.
- Ordinary governed memory recall and authorized writes remain independent of
  learning publication.

## Limitations

This evidence is deterministic and local. It uses a small synthetic corpus,
synthetic canary cases, one candidate type, one qualified platform, and no
production traffic. It proves the frozen test distribution and the governed
release/rollback mechanics. It does not prove general learning value,
production latency, operational durability, multi-user behavior, fleet
control, or production readiness.

M6 remains required for backup/restore, disk/WAL pressure, permissions,
observability, fault injection, exercised runbooks, and the final G6 release
decision. Until G6 passes, the runtime remains local experimental software
with independently disableable learning publication.

## Evidence

- [`g5-verification-report.json`](./g5-verification-report.json)
- [`g5-reproducibility-manifest.json`](./g5-reproducibility-manifest.json)
- [`g5-replay-report.json`](./g5-replay-report.json)
- [`g5-canary-report.json`](./g5-canary-report.json)
- [`g5-resource-report.json`](./g5-resource-report.json)
- [`g5-code-review.md`](./g5-code-review.md)
- [`ADR 0005`](../adr/0005-governed-learning-release.md)

`pnpm verify:g5` independently recomputes the frozen U8 identity and hard-rule
chain. The U8 machine report intentionally remains an immutable
pre-decision artifact with `decision_recorded=false`; this U9 document is the
separate terminal decision.
