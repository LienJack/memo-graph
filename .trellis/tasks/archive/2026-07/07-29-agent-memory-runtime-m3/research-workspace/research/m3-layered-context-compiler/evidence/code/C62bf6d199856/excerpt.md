# docs/evaluations/performance-envelope.md:6

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `M0 performance envelope`
- Why: The accepted envelope predeclares Small/Expected/Stress projection and relation counts, token budgets, latency targets, disk/memory reporting, and holdout isolation.

````text
     6  ## Dataset profiles
     7
     8  | Profile | Evidence events | Active L1 memories | L2/L3 projections | Relations | Blob bytes |
     9  | --- | ---: | ---: | ---: | ---: | ---: |
    10  | Small | 10,000 | 1,000 | 250 | 1,000 | 256 MiB |
    11  | Expected | 250,000 | 25,000 | 6,000 | 50,000 | 8 GiB |
    12  | Stress | 1,000,000 | 100,000 | 25,000 | 250,000 | 32 GiB |
    13
    14  ## Record envelope
    15
    16  - inline evidence p50: 2 KiB;
    17  - inline evidence p95: 32 KiB;
    18  - maximum inline text: 256 KiB;
    19  - larger payloads use content-addressed blobs;
    20  - maximum single test artifact: 16 MiB;
    21  - one serialized writer, up to four concurrent readers in the expected profile.
    22
    23  ## Context budgets
    24
    25  | Budget | Tokens |
    26  | --- | ---: |
    27  | Default compiled slice | 1,800 |
    28  | Interactive maximum | 4,096 |
    29  | Hard contract maximum | 32,000 |
    30
    31  The compiler must never exceed the caller's requested budget. Provenance and
    32  uncertainty metadata count toward the same budget.
    33
    34  ## Initial latency targets
    35
    36  Measured on the expected profile after warm-up:
    37
    38  | Operation | p50 | p95 |
    39  | --- | ---: | ---: |
    40  | Governed SQLite/FTS recall | <= 50 ms | <= 200 ms |
    41  | Context compilation | <= 100 ms | <= 400 ms |
    42  | Evidence/episode commit receipt | <= 40 ms | <= 150 ms |
    43  | Projection fallback decision | <= 25 ms | <= 100 ms |
    44
    45  M1 may revise a target only with a recorded G0 amendment before comparison.
    46  Graph and vector candidates must compare against the same profile and corpus.
    47
    48  ## Resource and reliability boundaries
    49
    50  - writer queue depth and age are observable;
    51  - WAL growth must be bounded by an explicit checkpoint policy;
    52  - a slow backup or checkpoint cannot block the MCP protocol loop;
    53  - benchmark reports include Node, OS, architecture, SQLite/SDK versions,
    54    dependency lock hash, warm-up, sample count, p50/p95, disk, and memory;
    55  - no benchmark may use holdout or transfer payloads for tuning.
````
