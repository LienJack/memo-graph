# G3 Layered Context Compiler Gate Decision

- Decision: **HOLD**
- Date: 2026-07-28
- Tested implementation commit:
  `cc6b55fe30a477340909029ea7e04bef2c85c470`
- Evidence-only commit: this decision, reports, and reproducibility metadata
- Parent roadmap: `07-28-agent-memory-runtime`
- Milestone task: `07-29-agent-memory-runtime-m3`
- Accepted M2 baseline:
  `31959fc841ddc95f7570e5e0f2028a1e6b00243e`

## Decision boundary

**HOLD M3 layered retrieval and keep the accepted M2 L0/L1 compiler as the
runtime fallback.**

The frozen G3 replay and compiler benchmark pass their declared cases, but the
required post-implementation review found untested normal-usage failures in
bounded retrieval, source-frontier validation, and multi-scope compilation.
Those gaps invalidate advancement even though the narrower replay metrics are
green. M4A graph, M4B vector, and M5 Learning Lab are not opened by this
decision.

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
`g3-reproducibility-manifest.json`. The reviewed executable remains the U7
commit; the HOLD correction changes documentation and evidence metadata only.

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

Within the frozen corpus, Arm C had no aggregate or partition regression. Its
strict improvement was
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

These results are necessary but not sufficient for GO. The corpus uses one
scope and a bounded candidate set that does not expose the review failures
below.

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

## Post-gate code review

The mandatory Tier 2 review ran over the complete M3 diff through evidence
commit `5e4c75404e288402c0c1253807cd9eed2a8414ef`. It found three P1 blockers:

1. `LayeredLaneRetrievers.#projections` asks SQLite for only
   `request.limit + 1` rows and applies lexical matching afterward. A relevant
   projection outside that prefix is reported as no match, and truncation is
   not observable.
2. `RecallOrchestrator.recall` enumerates at most 1,000 canonical L1 sources,
   but consolidation can bind a scope frontier to as many as 100,000 sources.
   Above 1,000 active L1 rows, the recomputed source frontier differs and
   otherwise valid projections are rejected.
3. `MemoryRuntime.#compileLayeredContext` selects one projection frontier for
   the entire request. A request containing multiple exact scopes can contain
   projections with distinct scope frontiers, so candidates from the other
   scopes fail compiler frontier equality.

The same review recorded one P2 observability defect: relation traversal
silently keeps only the first 100 start revisions without reporting that
truncation. Existing integration tests exercise one scope and do not cover
relevant projections beyond the initial database prefix or canonical source
counts above 1,000.

These are false-negative and explainability failures, not authorization
bypasses. The operator default still enables only `recent_l1`, and disabling
all projection lanes retains the accepted M2 behavior.

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
- Projection retrieval is not correct beyond its pre-filter database prefix.
- Source-frontier revalidation is not correct above 1,000 active L1 rows.
- One Context frontier cannot currently represent multiple scope-local
  projection frontiers.
- Relation-start truncation is not yet reflected in lane telemetry.

## Required evidence to leave HOLD

- Push projection relevance filtering into a bounded storage query or add a
  cursor/FTS design that proves relevant rows cannot be lost before ranking.
- Revalidate the exact source revisions used by returned projections without
  enumerating or silently truncating the entire scope.
- Define and test a deterministic multi-scope frontier representation,
  including exact replay and purge behavior.
- Report relation start-set truncation explicitly.
- Add regressions for more than one scope, a relevant projection beyond the
  first query page, and more than 1,000 active canonical L1 sources.
- Re-freeze a new executable candidate and rerun three-arm replay, Small
  resource evidence, Expected compiler evidence, full tests, build, lint,
  typecheck, frozen install, and dependency audit.

## Decision

**HOLD.**

The frozen replay demonstrates a promising strict holdout gain with no
observed safety regression, but the reviewed candidate does not yet satisfy
the full R10/R11/R19 retrieval and frontier contract. Projection lanes remain
disabled by default, and the accepted M2 L0/L1 compiler remains the release
boundary. No M4A, M4B, or M5 child may start from this gate until a new
hash-bound G3 decision closes the listed blockers.
