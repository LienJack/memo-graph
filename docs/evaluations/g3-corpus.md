# G3 Layered Context replay corpus

## Status

This document freezes the executable G3 comparison corpus. It is a local
evaluation contract, not a production-readiness claim and not the G3 adoption
decision. The decision and measured reports are produced only after the U7
implementation commit is frozen.

## Immutable base

G3 does not edit the M0 corpus. Every overlay descriptor binds the original
case ID, partition, and canonical case hash.

| Artifact | Hash |
| --- | --- |
| `fixtures/replay/manifest.json` raw bytes | `sha256:8827b6fd6f1db6df8643faa46cdd5ce1008c10cca092fada555e3896cd7804e3` |
| M0 manifest canonical JSON | `sha256:4c3b2a658b6f93ac09374d376edcac6f299b4628e891362c5568166d5561de0b` |
| `fixtures/g3/manifest.json` raw bytes | `sha256:674f73a1879795bf5b9a38b291c107782228984552ddee2b7460bbe083c5ecb2` |
| G3 manifest canonical JSON | `sha256:94c74e54ab560e9b80acf282802a5b485ac685c1cb3fe9c292ed648daffaa813` |

The loader rejects raw M0 manifest drift, canonical manifest drift, a changed
case body, a changed overlay, a partition mismatch, and any path that escapes
its declared partition.

## Partitions and cases

| Partition | Case IDs |
| --- | --- |
| calibration | `cal_normal_preference`, `cal_conflict_supersession`, `cal_correction_lineage`, `cal_privacy_scope`, `cal_temporal_validity` |
| holdout | `hold_deletion_no_resurrection`, `hold_persisted_prompt_injection`, `hold_multi_hop_lineage`, `hold_projection_failure` |
| transfer | `transfer_negative_transfer`, `transfer_policy_exclusion` |

Calibration, holdout, and transfer are loaded by separate partition-scoped
APIs. Calibration enumeration cannot read protected case payloads. All eleven
M0 cases are referenced exactly once.

## Three-arm protocol

Protocol version `1.0.0` runs each case at 512 and 1,800 tokens:

- Arm A, `accepted_m2`: exact commit
  `31959fc841ddc95f7570e5e0f2028a1e6b00243e` and dependency lock
  `sha256:e4d3347083d9b0147fc7ce581671196f3cc4883a5ef7663d179a3d44074dd695`;
- Arm B, `m3_no_projection`: the frozen M3 candidate with the governed L1
  compiler path;
- Arm C, `m3_layered`: the same M3 candidate with its operator-bounded
  projection lanes enabled.

Arm A is built in an isolated detached worktree with offline frozen
dependencies and invoked through the same JSON protocol as B and C. The
protocol requires the same case, partition, base hash, overlay hash, request
hash, budget, and ablation identity. Arm B must match A on semantic metrics and
the frozen Context hash.

## Overlay-only evaluation data

Projection transform inputs, required task units, required evidence units,
pollution rubrics, lane configuration, failure injection, and budgets exist
only in `fixtures/g3/`. They do not alter canonical M0 inputs or expected
outcomes. Every derived projection is rebuilt twice from the same input and
must be byte-identical.

The scorer records:

- task-unit and evidence-unit inclusion;
- named Context pollution categories;
- governance violations and source-memory lineage;
- abstention correctness and conflict explanation counts;
- token-budget overflow;
- rebuild equality;
- degraded lanes and exclusion reasons.

Any protected-partition leak, fixture/hash mutation, governance violation, or
budget overflow fails the executable gate. Leave-one-lane-out runs bind the
omitted lane into the request and result identity.

## Frozen benchmark profiles

The U7 harness declares the M0 workload sizes and fixed 20 warm-up plus 200
measured compiler samples.

| Profile | Evidence | Active L1 | L2/L3 projections | Relations | Warm-up | Samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 10,000 | 1,000 | 250 | 1,000 | 20 | 200 |
| Expected | 250,000 | 25,000 | 6,000 | 50,000 | 20 | 200 |

U8 may execute this frozen harness and write evidence reports, but may not
change the compiler, fixtures, policies, profiles, or benchmark logic.
The compiler command measures the bounded post-retrieval candidate set while
retaining the population identity in its output. The resource command
materializes the complete Small population in SQLite, validates exact active
object counts, measures database/WAL/memory growth, and compares the
incremental structural digest with a full rebuild. Projection maintenance
operations accept up to 100,000 rows for the Expected population; online lane
selection remains independently bounded to at most 1,000 candidates per lane.

## Reproduction

```bash
pnpm test:fixtures
pnpm exec vitest run tests/replay/layered-context-replay.test.ts \
  tests/replay/context-pollution.test.ts \
  tests/replay/projection-ablation.test.ts
pnpm test:g3:accepted
pnpm benchmark:g3 -- small
pnpm benchmark:g3 -- expected
pnpm benchmark:g3:resources
pnpm lint
pnpm typecheck
```
