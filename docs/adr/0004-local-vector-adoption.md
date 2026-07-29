# ADR 0004: Local semantic-vector adoption gate

- Status: Rejected candidate; G4B evidence forces NO-GO
- Date: 2026-07-29
- Gate: G4B

## Decision

Do not adopt or enable the evaluated local semantic-vector candidate.
Continue to support FTS5/recency, layered projections, and SQLite relations.
SQLite remains the only memory authority.

The terminal decision receipt is
[`g4b-decision.md`](../evaluations/g4b-decision.md).

The rejected candidate is:

- `@huggingface/transformers@4.2.0`;
- `Xenova/multilingual-e5-small` at
  `761b726dd34fb83930e26aab4e9ac3899aa1fa78`;
- `sqlite-vec@0.1.9` flat cosine on `better-sqlite3@13.0.1`;
- Darwin arm64, Node `24.18.0`;
- an operator-materialized, hash-verified, four-file local model snapshot
  with remote loading disabled.

No second model, runtime, index, platform, or tuned threshold is substituted.
A future attempt needs a new dated epoch, corpus, gate, and evidence chain.

## Why

The final candidate solved 0 of 6 frozen positive gaps and produced no strict,
holdout, or transfer gain. Two negative controls also failed because the
vector and hybrid arms degraded instead of producing the required governed
abstention. The repeated logical result was deterministic.

The first failed hard rule is therefore positive semantic utility, followed by
strict-gain, holdout, transfer, critical-regression, and negative-control
rules. Context-pollution delta is zero only because no vector candidate
survives the parent deadline; it is not a positive result.

The resource gate independently fails. A warm isolated child completes all
100 direct samples with a 25.29 ms p95, but cold readiness is 848.45 ms. The
governed runtime pays model-process startup per semantic retrieval while the
lane parent budget is at most 75 ms. All 100 governed recalls and all 100
Context compilations therefore degrade. Fast typed fallback and failure
cooldown pass their latency bounds but do not make the vector path adoptable.

Exact-scope governance, canonical post-validation, correction, revocation,
tombstone, purge, recovery, model identity, no-network operation, and typed
vector-free fallback remain valid implementation evidence.

## Authority and failure boundary

- Embeddings and vector indexes are disposable exact-scope projections.
- Vector hits propose revision IDs; fresh SQLite state decides eligibility.
- `sensitive` and `secret` revisions are excluded from vector membership.
- Clear principal/scope values and query text do not appear in vector paths.
- Missing, stale, locked, corrupt, rebuilding, timed-out, or exited vector
  state produces typed degradation and preserves vector-free operation.
- Model acquisition is an operator action. Runtime never downloads a model.
- The child process is crash/availability containment, not an OS sandbox.

## Reproducibility correction

U8 review found that the U2 qualification epoch bound the lock before the
MCP workspace added its vector package link. External candidate versions were
unchanged, but the complete repository lock hash changed. The final evidence
therefore uses a new epoch bound to the tested candidate lock and regenerated
reports.

U8 also found that the earlier recall timer covered only the child query, not
model-process startup. That allowed roughly one second of cold-start work to
appear as a successful 50 ms governed request. The final candidate enforces
one end-to-end parent deadline. This turns those apparent six semantic gains
into typed timeouts and is the correct adoption result.

Historical U2/U7 evidence remains a truthful record of those earlier units;
it is not the final cross-artifact identity or final decision input.

## Consequences

- `semantic_vector` stays disabled and receives no default maintenance work.
- Additive vector contracts, delivery metadata, tests, and derived-state
  recovery code may remain as inert evidence; they do not create an active
  runtime path.
- The private model snapshot is not a runtime prerequisite for supported
  operation.
- NO-GO is complete and releasable. It is not a failure of SQLite memory
  functionality.
- Even a future GO would be exact-platform, opt-in evidence and would not
  establish M6 production readiness.

The verifier, reports, scorecard, review, and recovery procedures live under
`docs/evaluations/`, `scripts/verify-g4b-evidence.mjs`, and
`docs/runbooks/vector-rebuild.md`.
