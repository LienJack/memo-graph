# G4A Local Graph Adoption Scorecard

## Decision

**Verified U8 result: NO-GO.**

The candidate does not satisfy the frozen structural-gain gate or the
resource gate. SQLite remains the authoritative ledger, graph recall remains
disabled by default, and no runtime adoption claim is made. U8 froze the
reviewed candidate and regenerated the evidence. U9 records the formal
decision and closure; it cannot reinterpret this evidence as GO.

GO is conjunctive:

```text
accepted baseline
AND identity/frozen-input gate
AND structural gate
AND governance gate
AND resource gate
```

The independent verifier treats missing, failed, or mixed-candidate evidence
as NO-GO.

## Frozen identity

| Field | Recorded value |
| --- | --- |
| Accepted G3R commit | `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| U8 reviewed candidate | `36421f5cd75007a1421d3e0594e7881dd4b864b2` |
| Dependency lock | `sha256:4ecf84c7b6b15287f83c346a764742843ae795f099d61c1f34bbcad6864b6066` |
| LadybugDB | `@ladybugdb/core@0.18.3`, storage `42` |
| Native binary | `sha256:57e07aa4aaaae7556c414ce9bfddb24f3a6e1e6b1b4a07882e3feb5e8261c6aa` |
| Platform | Darwin arm64 |
| Node / pnpm / SQLite | `24.18.0` / `10.33.2` / `3.53.3` |
| Protocol / transform | `G4A@1.0.0` / `g4a-frozen-topology-materializer@1.0.0` |

The reports also bind the evaluator, materializer, graph-free reference,
process host, native adapter, manifest, threshold, sample, lockfile, and native
binary hashes.

## Structural evidence

All arms used the same canonical governed scope, typed relation pattern,
frontier, request limits, budget, policy, and frozen expected outcome. Arm B
used the evaluation-only graph-free structural reference; Arm C used the
LadybugDB process. B and C were semantically identical in all six cases.

| Case | Partition | Accepted G3R | Graph-free B | LadybugDB C | Strict gain |
| --- | --- | --- | --- | --- | --- |
| Typed explanatory path | Calibration | Degraded | Pass | Pass | No |
| Temporal conflict | Calibration | Degraded | Pass | Pass | No |
| Scenario migration | Holdout | Degraded | Pass | Pass | No |
| Shortest valid proof | Holdout | Degraded | Pass | Pass | No |
| Cycle/fanout pressure | Transfer | Degraded | Degraded | Degraded | No |
| Mid-path correction | Transfer | Degraded | Pass | Pass | No |

Frozen requirements were at least three strict gains, including one holdout
and one transfer gain, with zero regressions. The observed result was:

- Strict gains: `0`
- Holdout gains: `0`
- Transfer gains: `0`
- Graph regressions: `g4a_transfer_cycle_fanout_pressure`
- Native/reference mismatches: `0`
- Governance violations: `0`
- Logical result hash:
  `sha256:bace9907a5cb451a6847aa35f13e32287128a03f4e97c09ce1844ed6bf625596`

Therefore `material_structural_gain=false`.

## Physical resource evidence

The following values are measured on Darwin arm64 unless marked declared or
missing. Timing values are one recorded U7 run and are not cross-platform
claims.

| Metric | Measured | Frozen threshold | Result |
| --- | ---: | ---: | --- |
| Warm-ups / samples | 20 / 100 | at least 20 / 100 | Pass |
| Graph-assisted p50 | 2.85 ms | at most 50 ms | Pass |
| Graph-assisted p95 | 3.30 ms | at most 200 ms | Pass |
| Typed fallback p95 | 76.77 ms | at most 100 ms | Pass |
| Process startup | 141.71 ms | Recorded, no adoption threshold | Informational |
| Replacement maximum | 184.72 ms | at most 2,000 ms | Pass |
| Six-scope rebuild | 234.68 ms | Recorded Small evidence | Informational |
| Expected native full rebuild | Missing | at most 60,000 ms | **Fail** |
| Graph database plus WAL | 1,884,160 bytes | at most 536,870,912 | Pass |
| Install delta | 19,849,707 bytes | at most 67,108,864 | Pass |
| Idle child RSS | 159,186,944 bytes | at most 134,217,728 | **Fail** |
| Peak observed child RSS | 240,336,896 bytes | at most 536,870,912 | Pass |
| Queue debt | 0 | 0 | Pass |
| Retained quarantine | 0 bytes | Recorded | Pass |

The declared Expected logical profile was materialized as 100 scopes with
25,000 active L1 memories, 6,000 L2/L3 projections, and 50,000 relations. Its
logical digest is
`sha256:d8a7968487ad9eaaa4477ced4ecbcdcb35d3e4bf47811bd36067c05fce6575c5`.

The Expected profile was **not** loaded into the native backend and its native
full-rebuild time was **not** measured after the structural gate had already
failed. The report records
`EXPECTED_NATIVE_PROFILE_NOT_RUN_AFTER_STRUCTURAL_GATE_FAILED`; no Small
measurement is extrapolated to Expected.

Therefore `resource_gate=false`.

## Evidence and reproduction

- `docs/evaluations/g4a-baseline-report.json`
- `docs/evaluations/g4a-structural-report.json`
- `docs/evaluations/g4a-resource-report.json`
- `docs/evaluations/g4a-code-review.md`
- `docs/evaluations/g4a-verification-report.json`
- `docs/evaluations/g4a-reproducibility-manifest.json`
- `fixtures/g4a/manifest.json`

```bash
pnpm test:graph
pnpm benchmark:graph
pnpm verify:g4a
pnpm test:g3r:h3
```

`pnpm verify:g4a` exits successfully only when the evidence is internally
consistent. For this evidence it prints:

```text
G4A evidence verified: NO-GO (structural_gate, resource_gate)
```
