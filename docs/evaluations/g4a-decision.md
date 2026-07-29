# G4A Local Graph Adoption Decision

## Decision

**NO-GO — completed M4A on 2026-07-29.**

The tested LadybugDB projection is not adopted for Context retrieval. The
first failed hard gate is the structural-value gate:

- strict gains: `0`, required `>= 3`;
- holdout gains: `0`, required `>= 1`;
- transfer gains: `0`, required `>= 1`;
- graph regressions:
  `g4a_transfer_cycle_fanout_pressure`, required `0`.

The supporting artifact is
`docs/evaluations/g4a-structural-report.json`, verified through
`docs/evaluations/g4a-reproducibility-manifest.json`.

SQLite adjacency and the accepted G3R compiler remain the active fallback.
The `relation_graph` lane remains unavailable/disabled for Context, graph
startup remains opt-in and default-off, and no native graph process is
authorized to auto-start.

## Tested identity

Exactly one implementation identity is used for the M4A decision:

| Field | Value |
| --- | --- |
| Candidate commit | `36421f5cd75007a1421d3e0594e7881dd4b864b2` |
| Dependency lock | `sha256:4ecf84c7b6b15287f83c346a764742843ae795f099d61c1f34bbcad6864b6066` |
| Package | `@ladybugdb/core@0.18.3` |
| Storage version | `42` |
| Native binary | `sha256:57e07aa4aaaae7556c414ce9bfddb24f3a6e1e6b1b4a07882e3feb5e8261c6aa` |
| Platform | Darwin arm64 |
| Node / pnpm / SQLite | `24.18.0` / `10.33.2` / `3.53.3` |
| Storage schema | `0012` |
| Graph schema | `GraphRevision/GraphLink/GraphScope@1.0.0` |
| G4A protocol | `G4A@1.0.0` |
| Transform | `g4a-frozen-topology-materializer@1.0.0` |

The manifest also binds all six workspace package trees, evaluation sources,
corpus, thresholds, reports, full-diff review and verification report.

## Gate results

| Gate family | Result | Evidence |
| --- | --- | --- |
| Qualification | Pass for one bounded spike | LadybugDB 0.18.3 is maintained enough for evaluation and locally passed the closed qualification probe |
| Implementation/containment | Pass | Optional dynamic load, child-process deadline/kill, identity checks, exact-scope projection and SQLite fallback passed |
| Structural value | **Fail — first failure** | 0 strict gains; 0 holdout; 0 transfer; one transfer regression |
| Governance/privacy | Pass | 0 governance violations; correction, usage block, demote, revoke, delete, purge and content-residual Oracles passed |
| Recovery/integrity | Pass | Transaction rollback, kill/reopen, stale lease, rebuild, restore and stale-backup Oracles passed |
| Resources | **Fail** | Expected native rebuild missing; idle RSS exceeds threshold |
| Full-diff review | Pass | 0 unresolved P0/P1 after nine resolved review findings |
| Artifact integrity | Pass | Independent verifier confirms one internally consistent NO-GO identity |

The decision is conjunctive. Passing containment and governance cannot
compensate for failing structural value or resources.

## Threshold record

| Metric | Required | Observed | Result |
| --- | ---: | ---: | --- |
| Strict gains over A and B | `>= 3` | `0` | Fail |
| Holdout strict gains | `>= 1` | `0` | Fail |
| Transfer strict gains | `>= 1` | `0` | Fail |
| Graph regressions | `0` | `1` | Fail |
| Governance violations | `0` | `0` | Pass |
| Warm-ups / measured samples | `>= 20 / 100` | `20 / 100` | Pass |
| Graph-assisted p50 | `<= 50 ms` | `2.85 ms` | Pass |
| Graph-assisted p95 | `<= 200 ms` | `3.30 ms` | Pass |
| Fallback p95 | `<= 100 ms` | `76.77 ms` | Pass |
| Replacement ready | `<= 2,000 ms` | `184.72 ms` | Pass |
| Expected native rebuild | `<= 60,000 ms` | Missing | Fail |
| Graph database + WAL | `<= 536,870,912 B` | `1,884,160 B` | Pass |
| Install delta | `<= 67,108,864 B` | `19,849,561 B` | Pass |
| Idle child RSS | `<= 134,217,728 B` | `159,186,944 B` | Fail |
| Peak child RSS | `<= 536,870,912 B` | `240,336,896 B` | Pass |
| Queue debt | `0` | `0` | Pass |
| Unresolved P0/P1 | `0 / 0` | `0 / 0` | Pass |

The Expected logical profile was materialized as 100 scopes, 25,000 active L1
memories, 6,000 L2/L3 projections and 50,000 relations. Its native physical
rebuild was deliberately not run after the structural gate had already
failed; the missing measurement remains a failure and is not extrapolated
from the six-scope run.

## Active runtime and artifact status

- SQLite remains authoritative for every identity, revision, scope,
  lifecycle, evidence root, tombstone, release pointer and receipt.
- `relation_sqlite`, FTS5, recency and the accepted G3R compiler remain the
  supported retrieval path.
- `relation_graph` remains disabled for Context and cannot be enabled by a
  caller when operator policy denies it.
- `@ladybugdb/core` remains an optional development/evaluation dependency; it
  is not a required SQLite-only runtime dependency.
- The graph process is not auto-started. It starts only under explicit graph
  configuration plus policy, request and checkpoint eligibility.
- Additive migration `0012`, source code, fixtures and reports remain inert
  evidence. Derived graph files may be safely deleted using
  `docs/runbooks/graph-rebuild.md`; deleting them loses no authoritative data.

## Scope and limitations

- Physical evidence is from macOS 15.5 / Darwin arm64 only.
- Linux, Windows and macOS x64 declarations were not physically verified.
- The corpus is a frozen synthetic governed evaluation, not production usage
  evidence.
- Process isolation is crash/availability containment, not an OS security
  sandbox against trusted native code or same-UID filesystem attacks.
- Expected native rebuild is unmeasured.
- This decision makes no vector, learning-release or M6 production-readiness
  claim.

## Reevaluation conditions

G4A may be reopened only as a new Trellis workflow with a new dated
brainstorm, current first-party research, reviewed plan and separate
implementation task. A rerun must:

1. qualify a currently maintained exact package/native identity;
2. preserve SQLite authority, default-off behavior and the same governance,
   purge, recovery and no-optional boundaries;
3. use the current frozen corpus/thresholds or version them before inspecting
   holdout/transfer outcomes;
4. produce at least three strict gains over both the accepted baseline and
   graph-free reference, including one holdout and one transfer, with zero
   regression;
5. physically run the Expected native rebuild within 60 seconds;
6. reduce idle child RSS to at most 128 MiB and pass every other resource
   threshold;
7. finish full verification, independent hash validation and review with zero
   unresolved P0/P1.

Until all conditions pass in one identity, the decision remains NO-GO.

## Downstream boundary

M4B is independent and may begin its own
`ce-brainstorm → research-to-article → ce-plan → ce-work` Trellis workflow.
G4A does not authorize M5 or M6, and it does not enable any optional retrieval
lane by default.

## Evidence

- `docs/evaluations/g4a-baseline-report.json`
- `docs/evaluations/g4a-structural-report.json`
- `docs/evaluations/g4a-resource-report.json`
- `docs/evaluations/g4a-code-review.md`
- `docs/evaluations/g4a-verification-report.json`
- `docs/evaluations/g4a-reproducibility-manifest.json`
- `docs/evaluations/graph-scorecard.md`

Verification:

```text
G4A evidence verified: NO-GO (structural_gate, resource_gate)
```
