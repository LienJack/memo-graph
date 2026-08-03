# M4B frozen semantic-gap subset

## Freeze identity

| Field | Frozen value |
| --- | --- |
| Frozen at | `2026-07-29T05:12:01.000Z` |
| Accepted G3R commit | `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| Accepted G3R lock hash | `sha256:e4d3347083d9b0147fc7ce581671196f3cc4883a5ef7663d179a3d44074dd695` |
| Candidate model/runtime/index | deliberately unselected |
| Machine-readable declaration | `semantic-gap-subset.json` |

This declaration freezes the semantic problem and adoption thresholds before
M4B selects, installs, probes, or tunes an embedding model or vector index.
Subsequent implementation may translate these cases into versioned contract
fixtures, but it must preserve every query, candidate body, lifecycle, scope,
valid-time boundary, expected revision ID, partition, threshold, and arm name.

## Why this is a real vector-free gap

The accepted SQLite reader compiles every normalized query token into an FTS5
`AND` expression and repeats the same all-terms rule for its canonical fallback.
The six positive cases deliberately avoid complete lexical overlap between the
query and the expected revision. They also contain no seed relation or active
task identifier that the accepted layered lanes could use to discover the
expected L1 revision. Therefore the accepted `fts_recency` and `layered` arms
must miss at least one expected revision under the frozen inputs.

This is not permission for similarity to become authority. Three negative
controls contain a highly similar wrong-scope, revoked, future, or expired
candidate. Every arm must preserve exact principal/scope, lifecycle, valid-time,
sensitivity, usage, lineage, tombstone, and purge checks before Context.

## Frozen cases

| Partition | Case | Gap/control | Expected result |
| --- | --- | --- | --- |
| calibration | `g4b_cal_irrecoverable_forgetting` | English paraphrase | purge policy revision |
| calibration | `g4b_cal_learning_pause_zh_en` | Chinese query to English memory | learning-pause revision |
| calibration | `g4b_cal_exact_scope_isolation` | wrong-scope similarity trap | local-scope Node revision only |
| holdout | `g4b_hold_projection_fallback` | operational paraphrase | governed fallback revision |
| holdout | `g4b_hold_correction_zh_en` | Chinese correction intent to English memory | immutable-successor revision |
| holdout | `g4b_hold_revoked_similarity_trap` | revoked high-similarity trap | active withdrawal revision only |
| transfer | `g4b_transfer_offline_operation` | offline semantic operation | pinned local-cache revision |
| transfer | `g4b_transfer_context_pollution` | conceptual paraphrase | bounded Context revision |
| transfer | `g4b_transfer_temporal_abstention` | future/expired similarity trap | abstain |

Calibration payloads may be used to choose vector thresholds. Holdout and
transfer payloads may be opened only by the final gate evaluator; their values
must not influence model, index, pooling, normalization, top-k, or fusion
tuning.

## Frozen comparison

All four arms use the same canonical revision set, principal, exact scope,
`as_of`, sensitivity policy, reader, token budgets, and Context Compiler:

1. `fts_recency` — accepted governed FTS5 plus recent L1 behavior;
2. `layered` — accepted G3R layered behavior without vectors;
3. `vector` — the one qualified vector candidate lane, still followed by
   canonical SQLite postvalidation;
4. `hybrid` — vector candidates fused with the unchanged accepted layered
   baseline, then passed through the same postvalidation and Context budget.

No arm may use candidate count or a raw similarity score as task success. A
positive case passes only when every expected live revision is included and no
ineligible revision enters Context. A negative control passes only when every
wrong-scope, inactive, revoked, future, expired, tombstoned, purged, sensitive,
secret, or usage-blocked result is excluded with the correct reason.

## Frozen G4B material-gain rule

G4B `GO` requires all of the following:

- hybrid solves at least five of the six positive cases;
- at least four cases are strict gains over both vector-free arms;
- strict gains include at least one holdout and one transfer case;
- critical governance, privacy, correction, purge, and resurrection
  regressions equal zero;
- Context pollution does not increase at either frozen token budget;
- disabled, missing, corrupt, stale, rebuilding, and timed-out vector state
  preserve the accepted vector-free result with typed degradation;
- warm expected-profile governed recall remains at or below 50 ms p50 and
  200 ms p95;
- warm expected-profile Context compilation remains at or below 100 ms p50 and
  400 ms p95;
- vector fallback remains at or below 100 ms p95.

The expected profile is the M0 envelope: 250,000 evidence events, 25,000 active
L1 memories, 6,000 L2/L3 projections, and 50,000 relations. Resource evidence
must additionally report p99 latency, model/cache bytes, index/WAL bytes, disk
growth, idle/peak RSS delta, cold start, rebuild duration, and epoch migration
duration. Those values cannot be hidden inside the utility score.

If the frozen gap is not reproduced, no current candidate passes hard local
privacy and operational qualification, or the one implemented candidate misses
any hard rule above, G4B records an evidence-backed `NO-GO` and retains the
vector-free runtime. That is a complete M4B outcome.
