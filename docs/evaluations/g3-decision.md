# G3 Layered Context Compiler Gate Decision

- Decision: **GO**
- Date: 2026-07-28
- Tested implementation commit:
  `cc6b55fe30a477340909029ea7e04bef2c85c470`
- Evidence-only commit: this decision, reports, and reproducibility metadata
- Parent roadmap: `07-28-agent-memory-runtime`
- Milestone task: `07-29-agent-memory-runtime-m3`
- Accepted M2 baseline:
  `31959fc841ddc95f7570e5e0f2028a1e6b00243e`

## Decision boundary

**GO to independent M4A graph, M4B vector, and M5 Learning Lab
experiments.**

This decision accepts the deterministic L2/L3 projection layer, governed
multi-lane recall, and layered Context Compiler implemented in M3. It does not
adopt a graph backend, vector backend, autonomous learning release, remote
transport, or production operations. Each downstream experiment retains its
own gate and may independently end in No-Go. The accepted L0/L1 path remains
the mandatory fallback.

No executable code, migration, dependency, fixture, or policy changed after
the tested U7 commit. U8 records evidence only.

## Frozen identity

| Field | Value |
| --- | --- |
| Candidate commit | `cc6b55fe30a477340909029ea7e04bef2c85c470` |
| Accepted M2 commit | `31959fc841ddc95f7570e5e0f2028a1e6b00243e` |
| Dependency lock SHA-256 | `e4d3347083d9b0147fc7ce581671196f3cc4883a5ef7663d179a3d44074dd695` |
| Base replay manifest, canonical SHA-256 | `4c3b2a658b6f93ac09374d376edcac6f299b4628e891362c5568166d5561de0b` |
| G3 overlay manifest, canonical SHA-256 | `94c74e54ab560e9b80acf282802a5b485ac685c1cb3fe9c292ed648daffaa813` |
| Storage schema | `0010` |
| Projection transform | `deterministic-layered-consolidation@1.0.0` |
| Context compiler / policy | `2.0.0` / `2.0.0` |
| G3 protocol | `1.0.0` |
| Environment | Node 24.18.0, pnpm 10.33.2, macOS 15.5 Darwin arm64, SQLite 3.53.3 |

The machine-readable identity and commands are in
`g3-reproducibility-manifest.json`.

## Three-arm replay

The frozen protocol executed 22 runs per arm: 11 cases at token budgets 512
and 1,800.

| Arm | Task included | Evidence included | Pollution | Governance | Budget overflow | Rebuild failure | Correct abstention |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A — accepted M2 | 12/22 | 16/24 | 0 | 0 | 0 | 0 | 22/22 |
| B — M3 without projections | 12/22 | 16/24 | 0 | 0 | 0 | 0 | 22/22 |
| C — M3 layered | 14/22 | 16/24 | 0 | 0 | 0 | 0 | 22/22 |

Arm A was checked from the exact accepted M2 commit in an isolated detached
worktree. Arms A and B were semantically equal and produced equal frozen
Context; there were no compatibility mismatches.

Arm C had no aggregate or partition regression. Its strict improvement was
the designated holdout `hold_multi_hop_lineage` case at both budgets, adding
one task inclusion per run. Calibration remained 10/10 task and 10/10
evidence; holdout increased from 2 to 4 task inclusions while remaining 6/6
for evidence. Transfer remained 0/0 because its cases are deliberate policy
exclusions, not retrieval wins.

The 110-run ablation isolated the causal lanes:

- removing `core` erased the multi-hop task gain at both budgets;
- removing `recent_l1` broke the projection-failure fallback at both budgets.

The projection-failure case degraded twice as designed and recovered through
the L1 lane. No failed replay case or invariant failure was observed.
Persisted prompt injection, negative transfer, and policy exclusion remained
excluded by policy.

## Performance and resource evidence

| Profile | Compiler p50 | Compiler p95 | Total request p50 | Total request p95 | Token budget |
| --- | ---: | ---: | ---: | ---: | --- |
| Small | 0.316 ms | 0.720 ms | 0.447 ms | 1.077 ms | Pass |
| Expected | 0.318 ms | 0.541 ms | 0.450 ms | 0.940 ms | Pass |
| Frozen compiler threshold | <= 100 ms | <= 400 ms | — | — | Required |

Compiler timing covers the deterministic bounded post-retrieval candidate
set while retaining each declared population identity. The Expected row is a
compiler-envelope measurement; it is not a physical 250,000-row SQLite load
or a production capacity claim.

The physically materialized Small profile contained exactly 10,000 evidence
rows, 1,000 L1 rows, 250 projections, and 1,000 relations. Projection build
took 3,622.551 ms and full rebuild took 329.400 ms. Incremental and rebuilt
digests were identical. The run used 59,592,704 database bytes, 16,430,592
WAL bytes, 76,056,064 bytes for the data root, and reached 701,038,592 RSS
bytes.

## Final verification

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm test:g3` | Pass: targeted replay plus exact accepted-M2 isolated checkout |
| `pnpm test` | Pass: 44 files, 194 tests; one environment-gated check separately passed above |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm audit --audit-level=high` | Pass: no known vulnerabilities |

The audit recovered from one transient registry `ECONNRESET` retry warning.
There are no failed or quarantined G3 cases. The normal full-suite run leaves
the exact-checkout case environment-gated; `pnpm test:g3:accepted` exercised
and passed it from the accepted commit.

## Known limits and debt

- All evidence is local and synthetic on one Darwin arm64 machine.
- Expected-profile timing does not physically materialize the declared
  250,000 evidence rows in SQLite.
- The result does not cover concurrent production traffic, remote MCP
  transport, long-running compaction, or cross-machine recovery.
- L2/L3 remains a SQLite-derived projection. No graph or vector dependency is
  accepted by this gate.
- Projection failure has a tested L1 fallback, but durable operational
  monitoring and incident response remain M6 work.
- Policy-excluded transfer cases prove safety boundaries, not positive
  cross-domain transfer value.

## Decision

**GO.**

Arm C satisfies every frozen condition: zero governance, budget, and rebuild
violations; no aggregate or partition regression; deterministic rebuild; and
a strict designated holdout improvement. M4A, M4B, and M5 may now start only
as separate Trellis child tasks with independent evidence and Go/No-Go
decisions. A downstream No-Go must preserve this accepted SQLite L0/L1/L2/L3
runtime and its lower-layer fallback.
