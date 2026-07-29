# G4B Vector Candidate Scorecard

Status: **U7 measured outcome is NO-GO.** This scorecard records the
frozen replay and resource evidence. It does not pre-empt the independent
U8 review or the final U9 decision receipt.

## Candidate and evidence

- Candidate: `Xenova/multilingual-e5-small` at
  `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, ONNX int8, mean pooling,
  L2 normalization, 384 dimensions, local-only model loading.
- Vector index: `sqlite-vec@0.1.9`, flat cosine search.
- Frozen manifest:
  `sha256:449981ac83b2bc415c60df5237d6c857777e2dda6c03b1778588aa052c6ae3d4`.
- Replay report:
  [`g4b-replay-report.json`](./g4b-replay-report.json),
  `sha256:484420e712396923f3add4be21a4ed8ca925446d55b0f404f757330c805c9d75`.
- Resource report:
  [`g4b-resource-report.json`](./g4b-resource-report.json),
  `sha256:9fc2d5e7d23e4bcf728605e3193e285401d33610c9e20bbb81d5b7a806728251`.

Both reports bind the last committed implementation baseline
`b1f7b293ceea46ab67ac25d7b761aa035527433d`. The resource report
additionally seals the U7 runner and helper source hashes so the
uncommitted evaluation harness cannot be confused with that baseline.

## Utility gate

| Check | Frozen requirement | Observed | Result |
|---|---:|---:|---|
| Positive cases solved | at least 5 of 6 | 6 of 6 | Pass |
| Strict vector/hybrid gains | at least 4 | 6 | Pass |
| Holdout gains | at least 1 | 2 | Pass |
| Transfer gains | at least 1 | 2 | Pass |
| Critical regressions | 0 | 0 | Pass |
| Negative-control regressions | 0 | 0 | Pass |
| Context-pollution delta | at most 0 | `+1` in three case families | **Fail** |
| Repeated logical result | identical | 2 of 2 hashes identical | Pass |

The candidate recovers all six positive semantic gaps and preserves exact
scope, lifecycle, correction, revocation, expiry, tombstone, purge, and
sensitivity controls. It nevertheless adds distractor Context in the
irrecoverable-forgetting, learning-pause, and projection-fallback
families. The frozen utility gate therefore fails even though raw recall
improves.

## Resource gate

Every latency family used 20 warmups and 100 measured samples.

| Check | Frozen requirement | Observed | Result |
|---|---:|---:|---|
| Direct warm child | complete samples recorded | 100 of 100 complete; p95 26.66 ms | Pass |
| Governed recall outcomes | 100 of 100 complete | 70 complete; 30 typed timeouts | **Fail** |
| Governed recall p50 / p95 | 50 / 200 ms | 598.33 / 779.62 ms | **Fail** |
| Context compile outcomes | 100 of 100 OK | 0 OK; 100 degraded | **Fail** |
| Context compile p50 / p95 | 100 / 400 ms | 1256.37 / 1770.73 ms | **Fail** |
| Missing-model fallback | 100 typed degradations; p95 at most 100 ms | 100 of 100; 1.15 ms | Pass |
| Expected native profile | 25,000 L1 across exact scopes | 100 scopes / 25,000 records | Pass |
| Full native rebuild | measured | 3721.10 ms | Pass |
| Epoch migration | measured | 3587.52 ms | Pass |

The direct warm child demonstrates that the pinned model and native index
can meet the latency envelope after startup. The governed path currently
opens an isolated model process per semantic retrieval. Its cold startup
and lifecycle cost dominate end-to-end recall and Context compilation,
causing typed timeouts and failed success-rate gates.

An identical second resource run preserved the overall `resource_gate =
false` decision. Governed p95 changed by only 2.79% and Context p95 by
20.69%, but governed completion changed from 70/100 to 100/100 while
remaining far above its latency bounds. Context stayed 0/100 OK and the
typed missing-model fallback stayed 100/100. This outcome sensitivity is
an additional adoption risk; it does not rescue the candidate.

The expected physical profile occupies 240,025,600 bytes for 100
exact-scope `sqlite-vec` indexes. The pinned model snapshot is 135,138,424
bytes and the measured dependency install delta is 36,851,697 bytes.
Observed child RSS was 570,818,560 bytes idle and 732,381,184 bytes at the
measured peak. These costs are recorded rather than compared against an
invented threshold because the frozen manifest defines no byte or RSS
ceiling.

## Boundary and disposition

SQLite remains the authoritative memory ledger. Vector state remains a
rebuildable, exact-scope derived projection and must stay disabled by
default. No model fetch is allowed at runtime, no vector hit bypasses
canonical SQLite post-validation, and a missing model degrades to the
non-vector path.

U7 does not authorize production adoption. A future candidate may be
re-evaluated only with a new immutable epoch and frozen evidence set. It
must eliminate Context pollution and amortize model-process lifecycle
cost without weakening process isolation, exact-scope governance,
typed fallback, or rollback.
