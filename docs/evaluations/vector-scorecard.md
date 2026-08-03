# G4B Vector Candidate Scorecard

Status: **U9 activated G4B NO-GO.** This scorecard records the frozen replay
and resource evidence used by the terminal
[`g4b-decision.md`](./g4b-decision.md).

## Candidate and evidence

- Candidate: `Xenova/multilingual-e5-small` at
  `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, ONNX int8, mean pooling,
  L2 normalization, 384 dimensions, local-only model loading.
- Vector index: `sqlite-vec@0.1.9`, flat cosine search.
- Frozen manifest:
  `sha256:449981ac83b2bc415c60df5237d6c857777e2dda6c03b1778588aa052c6ae3d4`.
- Replay report:
  [`g4b-replay-report.json`](./g4b-replay-report.json),
  `sha256:58b088d8cf943ed5bee1c86c91937eb093f77dd473a84124c563dcf09eb05318`.
- Resource report:
  [`g4b-resource-report.json`](./g4b-resource-report.json),
  `sha256:2c0bec6b23d071d128ed190724d73af1e2ca58f32fa3691d42e8d04eace7b960`.

Both reports bind reviewed implementation
`3eec7119b1e441d76523d0a57c328d4d811a4af3` and dependency lock
`sha256:87f5c3f5dde4b8f29758d83866e2afb7d4fd2ae5748e30d3aeed96738faaf585`.
The resource report additionally seals the runner, helper, and process-host
source hashes.

## Utility gate

| Check | Frozen requirement | Observed | Result |
|---|---:|---:|---|
| Positive cases solved | at least 5 of 6 | 0 of 6 | **Fail** |
| Strict vector/hybrid gains | at least 4 | 0 | **Fail** |
| Holdout gains | at least 1 | 0 | **Fail** |
| Transfer gains | at least 1 | 0 | **Fail** |
| Critical regressions | 0 | 2 | **Fail** |
| Negative-control regressions | 0 | exact-scope and revoked controls failed | **Fail** |
| Context-pollution delta | at most 0 | 0 in every case/budget | Pass |
| Repeated logical result | identical | 2 of 2 hashes identical | Pass |

The parent deadline now covers model-process startup as well as query work.
The isolated per-request runtime cannot become ready inside that budget, so
the governed vector and hybrid arms deliver no semantic candidates. This
eliminates Context pollution only by eliminating all vector contribution; it
is not a utility success. Exact-scope and revoked negative controls also fail
their frozen arm expectations because those arms degrade instead of producing
the required governed abstention. The result is deterministic and decisively
fails the frozen utility gate.

## Resource gate

Every latency family used 20 warmups and 100 measured samples.

| Check | Frozen requirement | Observed | Result |
|---|---:|---:|---|
| Direct warm child | complete samples recorded | 100 of 100 complete; p95 25.29 ms | Pass |
| Governed recall outcomes | 100 of 100 complete | 0 complete; 100 typed timeouts | **Fail** |
| Governed recall p50 / p95 | 50 / 200 ms | 0.51 / 1.33 ms fast typed failures | Pass latency only |
| Context compile outcomes | 100 of 100 OK | 0 OK; 100 degraded | **Fail** |
| Context compile p50 / p95 | 100 / 400 ms | 3.16 / 5.64 ms typed degradation | Pass latency only |
| Missing-model fallback | 100 typed degradations; p95 at most 100 ms | 100 of 100; 0.58 ms | Pass |
| Expected native profile | 25,000 L1 across exact scopes | 100 scopes / 25,000 records | Pass |
| Full native rebuild | measured | 3624.82 ms | Pass |
| Epoch migration | measured | 3632.59 ms | Pass |

The direct warm child demonstrates that the pinned model and native index
can meet the latency envelope after startup. The governed path currently
opens an isolated model process per semantic retrieval. Its cold startup
was measured at 848.45 ms, far beyond the parent lane budget. After the first
failure, the generation-scoped failure cooldown produces fast typed
degradations; these low latency percentiles do not represent successful
semantic work.

The expected physical profile occupies 240,025,600 bytes for 100
exact-scope `sqlite-vec` indexes. The pinned model snapshot is 135,138,424
bytes and the measured dependency install delta is 36,851,697 bytes.
Observed child RSS was 600,522,752 bytes idle and 929,185,792 bytes at the
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
