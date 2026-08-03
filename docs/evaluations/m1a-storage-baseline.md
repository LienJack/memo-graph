# M1A SQLite Storage Baseline

- Recorded at: 2026-07-28T14:09:21.663Z
- Implementation commit:
  `335fcf28e5f29fedcff640502851618ea9007c84`
- Gate: G1A
- Profile: M0 `Small`

## Runtime

| Field | Value |
| --- | --- |
| Node.js | 24.18.0 |
| pnpm | 10.33.2 |
| Platform | Darwin arm64, macOS 15.5 |
| SQLite | 3.53.3 through `better-sqlite3` 13.0.1 |
| Schema frontier | `0002` |
| Dependency lock SHA-256 | `7f1101efc690eb9d026477f9f0567ac7ad414f9d024d4e40a8dc5fd1d20b7321` |
| Migration 0001 SHA-256 | `707146d45e5f6d5e4c31740a85cd7eb81c43ec379bd39b2600cde533515e8e11` |
| Migration 0002 SHA-256 | `b70b77de89023929151ba1440d1a8971b7179bde9a5c40f529db6c99a74166f8` |
| Replay manifest SHA-256 | `8827b6fd6f1db6df8643faa46cdd5ce1008c10cca092fada555e3896cd7804e3` |

## Workload

The executable command was:

```text
pnpm benchmark:storage
```

It created 10,000 one-event episodes through the public worker client, drained
10,000 FTS outbox jobs, ran 200 scope-bound FTS searches, and created one
verified SQLite/blob snapshot.

| Dimension | Value |
| --- | ---: |
| Evidence events | 10,000 |
| Episodes | 10,000 |
| Search samples | 200 |
| FTS projections | 10,000 |
| Serialized writers | 1 |
| Concurrent readers | 1 |

This is the frozen Small profile. It is not evidence for the 250,000-event
Expected profile, the 1,000,000-event Stress profile, or four concurrent
readers.

## Results

| Operation | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| Evidence/episode commit receipt | 0.342 ms | 0.788 ms | 14.494 ms |
| Scope-bound FTS search | 0.290 ms | 0.338 ms | 1.505 ms |

Additional measurements:

| Measurement | Value |
| --- | ---: |
| FTS outbox drain total | 5,452.232 ms |
| Verified backup | 172.184 ms |
| End-to-end benchmark | 10,536.607 ms |
| Live database | 31,334,400 bytes |
| Snapshot database | 31,354,880 bytes |
| Total temporary data root | 67,043,768 bytes |
| RSS at measurement | 315,817,984 bytes |
| Heap used at measurement | 35,249,816 bytes |

The Small-profile p95 results are below the M0 numerical envelopes of 150 ms
for commit and 200 ms for governed SQLite/FTS recall. Because those envelopes
are defined on the Expected profile, this is directional baseline evidence,
not an Expected-profile performance pass.

The benchmark uses calibration-free synthetic strings and does not expose
holdout or transfer fixture payloads.
