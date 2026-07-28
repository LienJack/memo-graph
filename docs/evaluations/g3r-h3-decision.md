# G3R Bounded Recall Remediation Gate Decision

- Decision: **GO**
- Date: 2026-07-29
- Tested implementation:
  `6224f782c86712488d416d8101ef7c9fa477c0ae`
- Evidence commit before decision:
  `c092b26`
- Accepted M2 baseline:
  `31959fc841ddc95f7570e5e0f2028a1e6b00243e`
- Historical G3 candidate:
  `cc6b55fe30a477340909029ea7e04bef2c85c470`
- Provisional H3 candidate:
  `58b35d48020a2bd8ea3089b858d9a65eb3b9ff4b`

## Decision boundary

**G3R is GO for the bounded, scope-keyed L2/L3 Context capability implemented
at the tested commit.**

This supersedes the historical G3 HOLD as the current gate status; it does not
rewrite or delete that decision. The accepted M2 L0/L1 path remains the
operator default and tested fallback. Projection lanes are not automatically
enabled by this decision.

M4A graph, M4B vector, and M5 Learning Lab are now eligible to begin only as
separate Trellis tasks using the required brainstorm, research, plan, work,
review, and gate sequence. No graph/vector backend, learning release, M6
production release, push, or pull request is authorized here.

## Frozen identity

| Field | Value |
| --- | --- |
| Candidate commit | `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| Evidence commit | `c092b26` |
| Accepted M2 commit | `31959fc841ddc95f7570e5e0f2028a1e6b00243e` |
| Dependency lock SHA-256 | `e4d3347083d9b0147fc7ce581671196f3cc4883a5ef7663d179a3d44074dd695` |
| Base corpus canonical SHA-256 | `4c3b2a658b6f93ac09374d376edcac6f299b4628e891362c5568166d5561de0b` |
| G3 overlay canonical SHA-256 | `94c74e54ab560e9b80acf282802a5b485ac685c1cb3fe9c292ed648daffaa813` |
| H3 regression canonical SHA-256 | `4e17282d16c91c0296386bb8d1f5d2b673df4e14573b08554459dc086d2a8390` |
| Storage schema | `0011` |
| Projection transform | `deterministic-layered-consolidation@1.0.0` |
| Context compiler / policy | `3.0.0` / `2.0.0` |
| G3 protocol / overlay | `1.0.0` / `1.0.0` |
| Environment | Node 24.18.0, pnpm 10.33.2, macOS 15.5 Darwin arm64, SQLite 3.53.3 |

The complete hashes and source bindings are in
`g3r-h3-reproducibility-manifest.json`.

## Failure-oracle closure

| Oracle | Result |
| --- | --- |
| Relevant projection beyond the first page is returned or names the scan ceiling | Pass |
| Exact named lineage validates beyond a 1,000-row scope prefix | Pass |
| Each exact scope binds to its own deterministic V2 frontier | Pass |
| Relation start and fanout caps emit separate counts and reason codes | Pass |
| Correction excludes only affected descendants and retains unrelated ready scopes | Pass |
| V1 Context and receipt replay without byte changes | Pass |

Incomplete projection work cannot produce a clean `NO_MATCH`. A scan ceiling,
epoch mismatch, pending scope, source problem, or relation cap is represented
by typed telemetry and a degraded receipt while canonical L1 remains
available.

## Three-arm replay

The frozen protocol executed 22 runs per arm over 11 cases at token budgets
512 and 1,800.

| Arm | Task included | Evidence included | Pollution | Governance violations | Budget overflow | Rebuild failure | Correct abstention |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A — accepted M2 | 12/22 | 16/24 | 0 | 0 | 0 | 0 | 22/22 |
| B — candidate without projections | 12/22 | 16/24 | 0 | 0 | 0 | 0 | 22/22 |
| C — candidate layered | 14/22 | 16/24 | 0 | 0 | 0 | 0 | 22/22 |

Arms A and B are semantically equal and have equal frozen Context hashes.
Arm C retains calibration and transfer behavior, adds one task inclusion in
the designated holdout multi-hop case at both budgets, and produces no
governance, pollution, budget, rebuild, abstention, or partition regression.
The 110-run ablation attributes that gain to the `core` lane and confirms the
`recent_l1` fallback.

## Performance and recovery evidence

| Profile | Compiler p50 | Compiler p95 | Total request p50 | Total request p95 | Threshold result |
| --- | ---: | ---: | ---: | ---: | --- |
| Small | 0.319 ms | 0.428 ms | 0.449 ms | 0.673 ms | Pass |
| Expected | 0.309 ms | 0.419 ms | 0.432 ms | 0.693 ms | Pass |
| Required compiler threshold | <= 100 ms | <= 400 ms | — | — | Pass |

The physical Small run materialized exactly 10,000 evidence rows, 1,000 L1
memories, 250 projections, and 1,000 relations. Projection build took
3,632.913 ms; full rebuild took 329.538 ms; incremental and rebuilt digests
were equal.

Only Small was physically materialized. Expected is a compiler-envelope
profile, not a physical 250,000-row database test or a production-capacity
claim.

## Full verification and review

| Gate | Result |
| --- | --- |
| Full suite | Pass: 44 files, 237 passed, 1 skipped |
| Lint / typecheck / build | Pass |
| Frozen install | Pass |
| Production dependency audit | Pass: no known vulnerabilities |
| Original G3 plus isolated accepted-M2 replay | Pass |
| H3 focused suite | Pass: 70 passed, 1 environment-gated case |
| Evidence/source/report hashes | Pass for `6224f782...` |
| JSON, Markdown, Trellis context, diff hygiene | Pass |
| Full-diff review | Pass after one P1 was fixed; no unresolved P0/P1 |

The U8 review first rejected provisional candidate `58b35d4` because a
correction in one scope removed ready projections from an unrelated scope.
Commit `6224f78` fixed the scope-local frontier and aggregate fallback
behavior, and the refrozen evidence includes
`h3_unrelated_scope_retention`.

## GO rationale

- all historical H3 failure oracles and the U8 regression pass;
- accepted M2 parity remains exact when projections are disabled;
- the layered arm retains a strict designated holdout improvement;
- no governance, privacy, budget, rebuild, partition, or V1 replay regression
  is present;
- bounds and degraded states are explicit in Context telemetry and receipts;
- resource claims are limited to what was physically measured;
- every frozen artifact and candidate source hash verifies;
- full review has no unresolved P0/P1 finding.

## Remaining limits

- All measurements are local synthetic evidence from one machine.
- Projection lanes remain opt-in and disabled by default.
- SQLite is still the canonical authority; L2/L3 remains a rebuildable
  projection.
- G3R does not choose a graph or vector backend.
- G3R does not authorize learning publication or a production release.
- Operational monitoring, backup/restore exercises, migration rollout, and
  incident runbooks remain M6 work.

## Decision

**GO.**

The bounded layered Context implementation may be used as the accepted G3
candidate and downstream gates may start their own independent workflows.
The M2 L0/L1 path remains the default fallback until later configuration and
release gates explicitly change that boundary.
