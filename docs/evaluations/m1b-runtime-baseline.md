# M1B governed runtime baseline

- Recorded at: 2026-07-28T14:59:36.762Z
- Tested implementation commit:
  `cd1057776529c0cff04ec9a17548488bcddd00c1`
- Gate: G1
- Profile: M0 `Small`

## Runtime

| Field | Value |
| --- | --- |
| Node.js | 24.18.0 |
| pnpm | 10.33.2 |
| Platform | Darwin arm64, macOS 15.5 |
| SQLite | 3.53.3 through `better-sqlite3` 13.0.1 |
| Schema frontier | `0003` |

## Workload

The executable command was:

```text
pnpm benchmark:baseline
```

It populated 10,000 single-event episodes, projected FTS, then measured 200
principal-bound searches, 200 frozen Context compilations with retrieval
receipts, and 200 proposal episode commits with FTS drain.

| Dimension | Value |
| --- | ---: |
| Initial evidence events | 10,000 |
| Samples per measured operation | 200 |
| Scopes per request | 1 |
| Context token budget | 1,800 |
| Serialized writers | 1 |
| Concurrent readers | 1 |

## Results

| Operation | p50 | p95 | max | M0 p95 target |
| --- | ---: | ---: | ---: | ---: |
| Governed search | 0.591 ms | 0.728 ms | 9.892 ms | 200 ms |
| Context compilation and durable receipt | 0.768 ms | 1.009 ms | 10.455 ms | 400 ms |
| Episode commit and FTS drain | 1.627 ms | 4.350 ms | 15.796 ms | 150 ms |

All three Small-profile comparisons passed. The final temporary frontier was
10,200 evidence events at ledger epoch 10,200, with 400 recall requests and
200 frozen Context slices. RSS was 327,581,696 bytes and heap used was
18,647,336 bytes at measurement.

This benchmark exercises the governed kernel and worker-owned storage path. It
does not include stdio process startup or JSON-RPC transport latency; the real
stdio child-process behavior is covered separately by
`pnpm test:integration -- codex-explicit-loop`. The result is directional
Small-profile evidence, not an Expected/Stress-profile or multi-reader claim.
