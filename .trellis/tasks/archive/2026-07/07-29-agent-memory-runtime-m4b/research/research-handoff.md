# memo-graph M4B vector adoption research handoff

## 1. Research identity

| Field | Value |
| --- | --- |
| Topic | `memo-graph-m4b-vector-adoption` |
| Run | `RUN20260729-130620-m4b-current-local-embedd-c643b7` |
| Research date | 2026-07-29 |
| Repository | `/Users/lienli/Documents/GitHub/memo-graph` |
| Accepted G3R baseline | `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| Semantic-gap freeze | `92b632e` |
| Candidate qualification | `a429f04679899c53b9ed5cacc88d69d2d353b510` |
| Research result | proceed to one disabled-by-default vector spike; G4B remains undecided |

The research closes RQ001–RQ009. It authorizes one bounded implementation and
evaluation path. It does not authorize vector adoption, default enablement,
remote embedding, or a production-readiness claim.

## 2. Executive decision

Implement and evaluate exactly one candidate:

- `@huggingface/transformers@4.2.0`;
- overrides `adm-zip@0.6.0` and `sharp@0.35.3`;
- `Xenova/multilingual-e5-small` pinned to
  `761b726dd34fb83930e26aab4e9ac3899aa1fa78`;
- `onnx/model_int8.onnx` SHA-256
  `4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c`;
- 384 dimensions, mean pooling, L2 normalization, `query: ` and `passage: `
  prefixes;
- `sqlite-vec@0.1.9`, flat cosine.

Keep the lane disabled by default. If this combination misses any hard gate,
record G4B `NO-GO`; do not shop for another model or index inside M4B.

Supporting claims:

- bounded-spike decision: `CLd5fc73b502af`;
- embedding contract: `CL5c752ba8bedb`;
- flat-index selection: `CLd3c0f27f47a3`;
- dependency-audit boundary: `CL3fe1c2370270`.

## 3. Candidate comparison

| Candidate | First-party/current evidence | Boundary | M4B result |
| --- | --- | --- | --- |
| Transformers.js 4.2.0 | official release and pinned pipeline/environment source | full pipeline API; dependency overrides required | selected runtime |
| multilingual-e5-small | upstream and pinned converted model cards | 100 languages, 384 dimensions, prefix contract, 512-token truncation | selected model |
| sqlite-vec 0.1.9 flat | pinned Node docs and stable release with delete fix | reuses better-sqlite3; exact search cost grows with scope partition | selected index |
| FastEmbed.js 2.1.0 | project README and current release | second embedding abstraction and older ONNX runtime dependency | not selected |
| USearch 2.26.0 | project README and current release | separate native ANN lifecycle, save/load/delete and tuning surface | not selected |
| hnswlib-node | current-source scan | another native ANN lifecycle without a demonstrated need at the expected profile | not selected |

Primary evidence:

- Transformers release and pipeline: `W2a22084948ee`, `Waf1e651bb7c6`;
- local/remote environment controls: `W89b879354b64`;
- model cards: `We3b6b6c16b22`, `Wdd1cd1cd11e5`;
- sqlite-vec Node and release: `W7740beaa9540`, `W3786aa1920f4`;
- FastEmbed: `W5e067430e8b2`, `W4cc674b8708c`;
- USearch: `W0b5939278192`, `W7e1d478b4d4d`;
- dependency issue: `W4e59bb7a6a72`.

## 4. Frozen semantic gap

The accepted reader turns normalized query terms into an FTS5 `AND` query and
applies the same all-terms rule to its canonical fallback
(`Cf007b7a56c95`, `Ca2672b0223ad`). The committed candidate-free subset freezes:

- six positive English paraphrase, Chinese-to-English, operational, and
  conceptual gaps;
- three exact-scope, revoked-lifecycle, and temporal negative controls;
- calibration, holdout, and transfer partitions;
- token budgets 1,800 and 4,096;
- the four arms `fts_recency`, `layered`, `vector`, and `hybrid`;
- the material-gain and zero-regression rules.

The frozen declaration is `Cc25137c273bc`. Claims:

- reproducible vector-free gap: `CL4eaf935debd2`;
- freeze precedes candidate selection: `CL5cf8683fe7df`.

G4B `GO` requires:

1. hybrid solves at least five of six positive cases;
2. at least four strict gains over both vector-free arms;
3. at least one holdout and one transfer gain;
4. zero critical governance, privacy, correction, purge, or resurrection
   regression;
5. no Context-pollution increase;
6. disabled and degraded vector equivalence;
7. all M0 expected-profile latency targets.

Claims: `CL29a4bead9838`, `CLc3e66229817e`.

## 5. Authority and privacy contract

```text
canonical SQLite eligibility and exact-scope partition
  -> local passage embeddings for one embedding epoch
  -> disposable flat sqlite-vec projection
  -> bounded revision IDs plus distances
  -> fresh canonical SQLite batch revalidation and frontier check
  -> unchanged Context Compiler and token budget
  -> governed result or typed vector degradation
```

Hard boundaries:

- SQLite owns identity, principal, scope, lifecycle, valid time, sensitivity,
  usage, evidence, correction, tombstone, purge, and frontier truth.
- Vector state contains no authoritative-only content and cannot grant
  eligibility.
- Similarity never bypasses exact-scope prefilter or canonical postvalidation.
- Index partitioning must not expose cross-principal or cross-scope membership.
- Missing, corrupt, locked, digest-mismatched, stale, rebuilding, timed-out, or
  unavailable vector state cannot produce clean `NO_MATCH`.
- A failed vector lane returns typed degradation and preserves the accepted
  vector-free result.
- Remote embedding is out of scope and requires a separate explicit egress
  Product Contract.

Claims: `CL71fe4e3484df`, `CL157af48ec6bf`, `CLb84edd82e24b`,
`CL6680922c27f1`.

## 6. Mutation, purge, and epoch lifecycle

The current governance transaction already enqueues FTS/layered invalidation
and refresh work (`C0826353004b6`). Tombstone immediately clears current
identity and Context eligibility before asynchronous purge
(`C6db08876aafd`). M4B must add vector projection work to the same durable
causal boundary.

Required Oracle:

- correction or replacement makes the old revision ineligible before any
  vector cleanup completes;
- revoke, usage block, demote, conflict, tombstone, or purge does the same;
- stale vector hits are rejected by fresh canonical postvalidation;
- physical purge proves no old revision, embedding bytes, model-input cache,
  quarantine bytes, backup residue, or projection generation remains;
- an embedding epoch binds every model and index identity;
- rebuild publishes a new generation only after source-frontier and logical
  digest equality;
- epoch migration never changes canonical memory or revision identity;
- stale restore remains blocked by the canonical tombstone frontier.

Claims: `CL27e9a47c63b2`, `CL8995a9b2e0df`.

## 7. Local qualification results

The Node 24 / Darwin arm64 offline probe passed:

- pinned model load from an explicit local snapshot with remote access off;
- 384-dimensional normalized embedding;
- calibration semantic targets present in top five;
- exact-scope prefilter;
- sqlite-vec insert, cosine search, delete, close/reopen;
- model digest verification.

Observed micro-probe resources:

| Measurement | Result |
| --- | ---: |
| ONNX model | 118,054,593 bytes |
| local model snapshot | 135,147,520 bytes |
| temporary npm install | 429,264,896 bytes |
| vector database | 1,617,920 bytes |
| offline load | 530.680 ms |
| warm query plus search p50 | 2.649 ms |
| warm query plus search p95 | 6.107 ms |
| warm query plus search p99 | 7.450 ms |
| load RSS delta | 387,661,824 bytes |

Evidence: `Cb9b84da4319a`, `C103bc7c7fc07`. Claim:
`CL4a93c99fc602`.

These values prove only five-revision technical feasibility. They are not
expected-profile, stress, rebuild, or production capacity evidence.

## 8. First-failure hazards

### Offline model boundary

`env.cacheDir` plus `env.allowRemoteModels=false` failed with
`TypeError: this.tokenizer is not a function`. Materializing and hashing the
four required files under an explicit `env.localModelPath` passed. Runtime
recall must never download a model or treat a provider cache as an immutable
deployment snapshot.

### Dependency audit

The unmodified exact install reported four high-severity findings through
`onnxruntime-node -> adm-zip` and `sharp`. Overrides to `adm-zip@0.6.0` and
`sharp@0.35.3` made the isolated npm audit clean. The implementation must prove
the overrides through the repository frozen lockfile, full runtime suite, and
`pnpm audit --audit-level high`. Any incompatibility or high-severity finding
is immediate G4B `NO-GO`.

Evidence: `Cec0fd4a67da8`, `W4e59bb7a6a72`. Claim:
`CL3fe1c2370270`.

## 9. Expected-profile and scorecard contract

The M0 envelope (`C1ee77a963b85`) remains authoritative:

- 250,000 evidence events;
- 25,000 active L1 memories;
- 6,000 L2/L3 projections;
- 50,000 relations;
- governed recall <= 50 ms p50 and <= 200 ms p95;
- Context compile <= 100 ms p50 and <= 400 ms p95;
- fallback <= 100 ms p95.

The scorecard must separately report:

- case success and strict gain by arm and partition;
- expected revision inclusion and abstention;
- evidence utility and task outcome;
- Context pollution and token use;
- all exclusion reason counts;
- p50/p95/p99 latency;
- model, snapshot, index, WAL, quarantine, and total disk bytes;
- cold load, warm load, rebuild, and epoch migration time;
- idle and peak RSS;
- audit, full suite, recovery, purge, and disabled/fallback results.

Claim: `CL81c76dae16b2`.

## 10. Reproducible G4B receipt

The final decision manifest must bind:

- accepted baseline commit and lock hash;
- tested implementation commit and final lock hash;
- every frozen fixture and report SHA-256;
- runtime package, overrides, model ID/revision/file digests, embedding epoch,
  dimensions, dtype, pooling, normalization, prefixes, and index version;
- platform, Node, SQLite, warmup, and sample counts;
- thresholds and first-failure order;
- governance, purge, rebuild, restore, fallback, audit, and full-diff review
  results;
- G4B `GO` or `NO-GO`;
- active vector-free fallback configuration.

Claims: `CL03ab8b47aa28`, `CLc5046a03e130`.

## 11. Plan handoff

The implementation plan must:

1. freeze typed G4B contracts and translate the research subset without
   changing its semantics;
2. qualify the final pnpm lock and overrides before deep implementation;
3. build the local model verifier and disabled vector adapter;
4. add vector projection state, exact-scope partitioning, outbox invalidation,
   delete, rebuild, and embedding epochs;
5. integrate only revision-ID candidates through canonical postvalidation;
6. add typed disabled/degraded Context behavior;
7. run the frozen four-arm replay, governance, purge, recovery, resource,
   audit, and full-suite gates;
8. record a hash-bound G4B decision;
9. retain the vector-free path regardless of decision.

There are no unresolved product questions. Technical failures are resolved by
the predeclared `NO-GO` path, not by expanding M4B scope.
