# G4B Local Semantic-Vector Decision

Status: **NO-GO**

Decision date: 2026-07-29

## Decision

Do not adopt or enable the evaluated `semantic_vector` lane. Keep the accepted
vector-free runtime active:

- SQLite is the sole canonical memory authority;
- FTS5 and recency remain the lexical L1 retrieval path;
- layered Topic/Scenario/Core projections and SQLite relations remain the
  supported higher-level path;
- the graph lane remains disabled under the independent G4A `NO-GO`;
- vector projection maintenance is disabled by default.

The additive vector contracts, derived-state code, tests, and runbook may
remain as inert experiment evidence. They do not authorize model installation,
index maintenance, runtime enablement, or a production-readiness claim.

## Frozen decision identity

- Accepted vector-free baseline:
  `6224f782c86712488d416d8101ef7c9fa477c0ae`
- Tested vector implementation:
  `3eec7119b1e441d76523d0a57c328d4d811a4af3`
- Evidence commit:
  `7d183f6`
- Dependency lock:
  `sha256:87f5c3f5dde4b8f29758d83866e2afb7d4fd2ae5748e30d3aeed96738faaf585`
- Embedding epoch:
  `sha256:05bde32839153fa41ba5359fd19112a1246aa1d7ebaf7dfef448b7869e8ed5cf`
- Candidate: `@huggingface/transformers@4.2.0`,
  `Xenova/multilingual-e5-small` at
  `761b726dd34fb83930e26aab4e9ac3899aa1fa78`,
  `sqlite-vec@0.1.9`, and `better-sqlite3@13.0.1`
- Qualified platform: Darwin arm64, Node `24.18.0`, pnpm `10.33.2`
- Replay report:
  `sha256:58b088d8cf943ed5bee1c86c91937eb093f77dd473a84124c563dcf09eb05318`
- Resource report:
  `sha256:2c0bec6b23d071d128ed190724d73af1e2ca58f32fa3691d42e8d04eace7b960`

No candidate, threshold, Context budget, holdout payload, model file, index,
dependency lock, or expected profile was substituted after freeze.

## Gate result

The first failed hard gate is `hybrid_positive_success`: the frozen hybrid arm
solved `0/6` positive semantic-gap cases against a requirement of at least
`5/6`. The result therefore became `NO-GO` before later failures were
considered.

All later measurements remain visible:

| Gate | Result | Evidence |
| --- | --- | --- |
| Dependency, audit, offline and process qualification | Pass | Pinned optional dependencies, no high-severity audit findings, four-file local model identity, no runtime download, and optional-dependency-free MCP startup |
| Governance, privacy and authority | Pass | Exact principal/scope partition, sensitive/secret exclusion, fresh SQLite postvalidation, and no Context bypass |
| Correction, revoke, demote, usage block, tombstone and purge | Pass | Immediate canonical suppression plus convergent derived cleanup |
| Rebuild, epoch migration, restore and outage recovery | Pass | Typed degradation, exact fallback, monotonic checkpoints, deterministic logical digests, and recovery Oracles |
| Disabled/degraded vector-free equality | Pass | The accepted vector-free result remains available and vector is not a startup dependency |
| Positive semantic utility | Fail | `0/6` positives solved; `0` strict, holdout, or transfer gains |
| Critical/negative controls | Fail | Exact-scope and revoked-control arms degraded instead of satisfying their frozen abstention Oracles |
| Context pollution | Pass only by non-delivery | Delta is zero because no vector candidate survives the end-to-end deadline |
| Governed resource outcome | Fail | `0/100` governed recalls complete and `0/100` Context compilations return OK |
| Direct warm model/index | Pass | `100/100` direct samples complete; p95 `25.29 ms` |
| Cold startup and lifecycle fit | Fail adoption rationale | Cold ready `848.45 ms` exceeds the `50–75 ms` parent lane budget |
| Full review and evidence verification | Pass | Zero unresolved P0/P1; verifier forces `NO-GO (utility_gate, resource_gate)` |

Fast governed p50/p95 values are cooldown degradations, not successful
semantic work. Resource costs, full rebuild, epoch migration, disk, and RSS
remain recorded in the scorecard even though utility already failed.

## Consequences and rollback

- `semantic_vector` stays disabled in default MCP composition.
- No model snapshot is required for supported operation.
- No vector projection maintenance runs by default.
- Operators use the accepted G3R SQLite/FTS5/layered/relations runtime.
- A vector outage cannot block canonical reads, writes, correction, purge, or
  Context compilation on vector-free lanes.
- A future attempt must start a new dated Trellis task with a newly frozen
  corpus, candidate, dependency lock, epoch, thresholds, reports, and decision.
  M4B does not authorize trying a second candidate.
- This decision completes M4B. It does not establish M6 production readiness.

## Handoff to M5

M5 Learning Lab may proceed in candidate-only mode. Every three-arm learning
evaluation and release receipt must name:

- G4A decision: graph `NO-GO`, SQLite relations active;
- G4B decision: vector `NO-GO`, FTS5/layered/SQLite relations active;
- the exact retrieval configuration used by no-candidate, current, and
  candidate arms.

Learning may not reinterpret this vector experiment as an accepted retrieval
lane or tune around its failed gate.

## Verification

The decision is derived from:

- [`g4b-replay-report.json`](./g4b-replay-report.json)
- [`g4b-resource-report.json`](./g4b-resource-report.json)
- [`g4b-reproducibility-manifest.json`](./g4b-reproducibility-manifest.json)
- [`g4b-verification-report.json`](./g4b-verification-report.json)
- [`vector-scorecard.md`](./vector-scorecard.md)
- [`g4b-code-review.md`](./g4b-code-review.md)
- [`ADR 0004`](../adr/0004-local-vector-adoption.md)

`pnpm run verify:g4b` independently recomputes the frozen identity chain and
rejects `GO` because both utility and resource gates are false.
