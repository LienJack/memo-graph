# M4B local vector candidate qualification

## Result

One bounded candidate combination qualifies for an implementation spike:

| Boundary | Qualified value |
| --- | --- |
| Node | `24.18.0`, Darwin arm64 |
| Runtime | `@huggingface/transformers@4.2.0` |
| Runtime overrides | `adm-zip@0.6.0`, `sharp@0.35.3` |
| Model | `Xenova/multilingual-e5-small` |
| Model revision | `761b726dd34fb83930e26aab4e9ac3899aa1fa78` |
| Model artifact | `onnx/model_int8.onnx` |
| Model SHA-256 | `4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c` |
| Embedding contract | 384 dimensions, mean pooling, L2 normalization |
| Text contract | `query: ` and `passage: ` prefixes |
| Index | `sqlite-vec@0.1.9`, flat cosine |
| Remote embedding endpoint | none |
| Runtime model access | explicit private local snapshot; remote disabled |

This is qualification for one G4B spike, not a `GO`. The frozen holdout,
transfer, expected-profile, governance, purge, rebuild, fallback, review, and
audit gates remain closed.

## Reproducible procedure

The checked-in `local-vector-probe.mjs` was copied to a fresh `/tmp` directory.
The directory used exact npm dependencies:

- `@huggingface/transformers@4.2.0`;
- `sqlite-vec@0.1.9`;
- `better-sqlite3@13.0.1`;
- overrides `adm-zip@0.6.0` and `sharp@0.35.3`.

The model was fetched once from the pinned Hugging Face revision. Exactly four
files were materialized into a private local snapshot:

| File | SHA-256 |
| --- | --- |
| `config.json` | `cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1` |
| `tokenizer.json` | `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39` |
| `tokenizer_config.json` | `a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b` |
| `onnx/model_int8.onnx` | `4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c` |

The final probe set `env.allowRemoteModels=false`, pointed
`env.localModelPath` at that snapshot, and performed no remote embedding call.
The complete machine-readable output is `local-candidate-probe.json`.

## Capability evidence

The final offline run passed:

- pinned model load on Node 24 / Darwin arm64;
- 384-dimensional normalized passage and query embeddings;
- both calibration semantic targets present in the top five;
- exact-scope prefiltering excluded the more lexically similar foreign-scope
  revision before vector insertion;
- `sqlite-vec` extension version `v0.1.9`;
- flat cosine insertion and KNN query;
- deletion removed the old revision immediately;
- close/reopen preserved the logical ordered result.

Observed normalization norms ranged from `0.9999997860` to `1.0000002825`.
The English purge paraphrase ranked second, behind the backup distractor, while
the Chinese-to-English learning-pause case ranked first. This is enough to
justify a hybrid top-k implementation spike, but it is not sufficient to claim
task utility or acceptable Context pollution.

## Resource evidence

| Measurement | Observed |
| --- | ---: |
| Pinned ONNX model | 118,054,593 bytes |
| Complete local model snapshot | 135,147,520 bytes |
| Temporary npm `node_modules` | 429,264,896 bytes |
| Probe vector database | 1,617,920 bytes |
| Offline model load | 530.680 ms |
| Five-passage batch | 39.346 ms |
| Warm query + flat search p50 | 2.649 ms |
| Warm query + flat search p95 | 6.107 ms |
| Warm query + flat search p99 | 7.450 ms |
| Observed load RSS delta | 387,661,824 bytes |

The warm micro-probe is well inside the M0 recall latency target, but the
dataset contains only five exact-scope calibration revisions. It does not
predict expected-profile latency, rebuild time, or Context compilation cost.
The install footprint and RSS delta are material costs that the G4B scorecard
must report independently.

## Two qualification hazards

### Local cache is not the offline deployment boundary

Setting only `env.cacheDir` and `env.allowRemoteModels=false` loaded an
incomplete pipeline and failed on first use with:

```text
TypeError: this.tokenizer is not a function
```

An explicit local model snapshot under `env.localModelPath` passed. Product
code must therefore treat model acquisition as a separate, hash-verifying
operator action. Runtime recall must never silently fetch a model or assume
that a provider cache is an immutable deployment artifact.

### Exact upstream dependencies fail the high-severity audit

The initial exact install reported four high-severity findings through
`onnxruntime-node -> adm-zip` and `sharp`. There was no declared upstream fix
for the exact transformer dependency set. Overrides to `adm-zip@0.6.0` and
`sharp@0.35.3` produced a zero-vulnerability npm audit in the isolated probe.

The implementation spike must repeat the repository's frozen-lockfile install,
runtime probe, full test suite, and `pnpm audit --audit-level high` with those
overrides. If either override breaks compatibility, becomes vulnerable, or
cannot be justified in the checked lockfile, G4B is `NO-GO`.

## G4B implementation boundary

Proceed with exactly this combination and no second model or index:

1. vector records remain disposable, epoch-bound projections;
2. only canonically eligible exact-scope revisions are embedded or searched;
3. the index returns revision IDs and distances, never authoritative content;
4. SQLite performs a fresh batch postvalidation before Context;
5. missing local model, digest mismatch, unavailable extension, stale epoch,
   timeout, corruption, or rebuild state yields typed vector degradation and
   the accepted vector-free path;
6. the lane stays disabled by default through the G4B decision;
7. holdout and transfer payloads are not used for tuning.

If this single candidate misses any hard gate, record `NO-GO`; do not continue
shopping for another model or index inside M4B.
