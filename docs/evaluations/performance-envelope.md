# M0 Performance and Workload Envelope

This document freezes workloads and budgets before M1 implementation. Values
are acceptance targets to test, not measured production results.

## Dataset profiles

| Profile | Evidence events | Active L1 memories | L2/L3 projections | Relations | Blob bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 10,000 | 1,000 | 250 | 1,000 | 256 MiB |
| Expected | 250,000 | 25,000 | 6,000 | 50,000 | 8 GiB |
| Stress | 1,000,000 | 100,000 | 25,000 | 250,000 | 32 GiB |

## Record envelope

- inline evidence p50: 2 KiB;
- inline evidence p95: 32 KiB;
- maximum inline text: 256 KiB;
- larger payloads use content-addressed blobs;
- maximum single test artifact: 16 MiB;
- one serialized writer, up to four concurrent readers in the expected profile.

## Context budgets

| Budget | Tokens |
| --- | ---: |
| Default compiled slice | 1,800 |
| Interactive maximum | 4,096 |
| Hard contract maximum | 32,000 |

The compiler must never exceed the caller's requested budget. Provenance and
uncertainty metadata count toward the same budget.

## Initial latency targets

Measured on the expected profile after warm-up:

| Operation | p50 | p95 |
| --- | ---: | ---: |
| Governed SQLite/FTS recall | <= 50 ms | <= 200 ms |
| Context compilation | <= 100 ms | <= 400 ms |
| Evidence/episode commit receipt | <= 40 ms | <= 150 ms |
| Projection fallback decision | <= 25 ms | <= 100 ms |

M1 may revise a target only with a recorded G0 amendment before comparison.
Graph and vector candidates must compare against the same profile and corpus.

## Resource and reliability boundaries

- writer queue depth and age are observable;
- WAL growth must be bounded by an explicit checkpoint policy;
- a slow backup or checkpoint cannot block the MCP protocol loop;
- benchmark reports include Node, OS, architecture, SQLite/SDK versions,
  dependency lock hash, warm-up, sample count, p50/p95, disk, and memory;
- no benchmark may use holdout or transfer payloads for tuning.
