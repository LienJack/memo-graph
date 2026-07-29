# Agent Memory Runtime M4B — Technical Design

## 1. Objective

M4B decides whether one pinned, local semantic-vector candidate provides
material governed recall value beyond the accepted FTS5/recency/layered/
SQLite-relation runtime.

The design supports two terminal paths:

- **GO:** retain the tested `semantic_vector` lane as disabled-by-default and
  opt-in on the explicitly verified platform.
- **NO-GO:** keep the accepted vector-free runtime and preserve the experiment
  as reproducible decision evidence.

In both paths SQLite remains authoritative and vector state remains
disposable.

## 2. Authority and traceability

1. Product Contract R9–R14, R19, and R20 are the only product requirement
   identifiers used by M4B.
2. `prd.md` owns scoped product acceptance.
3. `research/research-handoff.md` owns external Claim/Evidence and candidate
   qualification.
4. `research/semantic-gap-subset.json` owns the candidate-free frozen
   evaluation problem.
5. This document owns component, process, persistence, epoch, projection,
   recall, privacy, and failure boundaries.
6. `implement.md` owns unit order, test-first execution, focused verification,
   commits, and hard stops.
7. `docs/plans/2026-07-29-004-feat-local-vector-adoption-plan.md` is the
   unified ce-plan execution view.
8. G4B evidence and decision artifacts own the final tested identity and
   outcome.

## 3. Frozen candidate and gate constants

| Item | Frozen value |
| --- | --- |
| Accepted G3R baseline | `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| Runtime | `@huggingface/transformers@4.2.0` |
| Runtime overrides | `adm-zip@0.6.0`, `sharp@0.35.3` |
| Model | `Xenova/multilingual-e5-small` |
| Model revision | `761b726dd34fb83930e26aab4e9ac3899aa1fa78` |
| ONNX artifact | `onnx/model_int8.onnx` |
| ONNX SHA-256 | `4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c` |
| Dimensions | 384 |
| Pooling / normalization | mean / L2 |
| Text prefixes | `query: ` / `passage: ` |
| SQLite binding | reuse exact `better-sqlite3@13.0.1` |
| Index | `sqlite-vec@0.1.9`, flat cosine |
| Qualified platform | Node `24.18.0`, Darwin arm64 |
| Positive/control cases | 6 / 3 |
| Partitions | 3 calibration, 3 holdout, 3 transfer |
| Token budgets | 1,800 and 4,096 |
| Arms | `fts_recency`, `layered`, `vector`, `hybrid` |
| Hybrid success | >=5 of 6 positive cases |
| Strict gain | >=4, including holdout and transfer |
| Critical regressions | 0 |
| Context pollution increase | 0 |
| Recall p50/p95 | <=50/200 ms |
| Context p50/p95 | <=100/400 ms |
| Fallback p95 | <=100 ms |
| Expected profile | 250k events, 25k active L1, 6k L2/L3, 50k relations |

The four snapshot files and hashes are frozen in
`research/local-candidate-probe.md`. Any package, model, file, dimensions,
pooling, normalization, prefix, index, or distance change defines another
candidate and is outside M4B.

## 4. Component boundaries

### 4.1 Contracts

`@memo-graph/contracts` owns:

- model snapshot and embedding epoch identity;
- vector generation, record, query, result, and logical digest;
- process health and typed failure/degradation categories;
- exact-scope checkpoint, outbox work, publication, and receipt;
- `semantic_vector` lane and bounded-work telemetry;
- G4B corpus, arm, measurement, resource, and decision evidence.

Contracts contain no Transformers.js, ONNX, or sqlite-vec API types.

### 4.2 Canonical SQLite storage

`@memo-graph/storage-sqlite` remains the sole persistence authority and owns:

- embedding epoch registry;
- content-free vector-delivery outbox and leases;
- exact-principal/scope checkpoints and active generation identity;
- canonical source frontier, next validity transition, and logical digest;
- governed source enumeration and batch eligibility validation;
- transaction-coupled invalidation on canonical lifecycle changes;
- purge, restore, backup, and rebuild receipts;
- monotonic publication and tombstone-frontier checks.

The storage worker decodes all new requests and responses. Storage never
imports the vector package or an embedding dependency.

### 4.3 Vector retrieval package

`@memo-graph/vector-retrieval` owns:

- model snapshot verifier;
- injectable embedding port;
- injectable flat vector index port;
- parent process supervisor and decoded child protocol;
- Transformers.js/sqlite-vec child adapter;
- exact-scope projector and full rebuilder;
- canonical logical vector digest;
- governed semantic retriever;
- real-candidate resource measurement.

Optional candidate dependencies are dynamically imported only inside the
child. sqlite-vec uses the repository's existing exact
`better-sqlite3@13.0.1`; the vector package declares that relationship
explicitly instead of relying on pnpm hoisting. The package top level remains
importable with optional candidate dependencies omitted.

The package depends one-way on contracts and the public SQLite client. The
memory kernel consumes a backend-neutral semantic retriever port. MCP is the
composition root.

### 4.4 Memory kernel

`@memo-graph/memory-kernel` owns:

- operator/request lane policy intersection;
- accepted vector-free lane execution;
- optional `semantic_vector` scheduling;
- canonical batch re-read and eligibility/frontier validation;
- duplicate/fusion handling;
- lane status, bounded work, and fallback behavior;
- canonical candidate transfer to the pure Context Compiler.

It never opens vector files or trusts a similarity hit.

### 4.5 Context compiler and MCP

The compiler remains pure and:

- accepts only canonically materialized candidates;
- applies the same conflict, complementarity, duplicate, provenance, and token
  rules to semantic candidates;
- treats incomplete vector work as degraded;
- seals epoch/distance/status telemetry into immutable receipts without raw
  query or passage text.

MCP explicitly configures evaluation/enablement and an operator-owned local
model root. Defaults remain vector-free. Missing packages or model files must
not fail SQLite-only startup.

## 5. Embedding epoch

An embedding epoch is immutable and binds:

- Transformers package and resolved dependency identities;
- model repository and revision;
- four relative model-file paths and SHA-256 hashes;
- ONNX graph identity and dtype;
- tokenizer/truncation behavior;
- 384 dimensions;
- mean pooling;
- L2 normalization;
- query and passage prefixes;
- sqlite-vec package/extension version;
- flat cosine metric;
- vector projection schema version.

The normalized ordered epoch envelope produces the epoch ID. Runtime ready
requires exact equality with operator configuration and the local snapshot.
There is no "compatible enough" epoch.

Canonical memory identity does not include embedding epoch. Changing the epoch
rebuilds disposable projections without changing memory/revision identity.

## 6. Offline model boundary

### 6.1 Materialization

Model acquisition is outside recall and projection execution. An operator:

1. obtains the four files from the pinned upstream revision;
2. places them under a private local model root;
3. verifies path confinement, regular-file status, size, and all hashes;
4. supplies only the model root through local process configuration.

The repository does not commit model bytes.

### 6.2 Runtime

The child:

- sets remote model access off before loading the runtime;
- sets the explicit local model path;
- resolves only the closed model identity;
- verifies the same files again before ready;
- never accepts a remote URL or model name from a recall request;
- never writes query/passage text to disk or logs;
- clears operation buffers after use to the extent supported by JavaScript
  ownership; it does not claim secure memory erasure.

A provider cache is never a deployment identity.

## 7. Process isolation

### 7.1 Parent lifecycle

The parent:

1. validates configuration, epoch, and data-root confinement;
2. derives a vector scope path from a one-way principal/exact-scope hash;
3. rejects symlink or path escape;
4. launches one child with an allowlisted environment;
5. waits for a decoded ready/epoch/extension response;
6. assigns bounded unique request IDs;
7. enforces operation deadlines and response matching;
8. on timeout, crash, malformed response, or identity mismatch, quarantines
   and terminates the child;
9. returns typed degradation without waiting for replacement;
10. restarts outside the recall critical path with rate limiting and cooldown;
11. leaves SQLite and vector-free lanes open throughout.

The host may pool one idle child or serialize multiple scope databases through
one child, but it cannot let different scope results share index membership.
The simplest correct implementation wins.

### 7.2 Child lifecycle

The child:

- dynamically imports pinned Transformers.js and sqlite-vec;
- reports runtime, model, file, extension, platform, and architecture identity;
- owns opened vector database handles;
- decodes a versioned closed command set;
- enforces dimensions, batch, payload, top-k, and timeout bounds;
- performs explicit transactions for vector replacement;
- closes statements, database handles, IPC, and timers;
- exits on malformed protocol or parent disconnect.

The child accepts no arbitrary SQL, file path, model ID, URL, or environment
override.

### 7.3 Containment claim

The process boundary protects MCP availability and permits OS termination. It
is not an OS sandbox: native dependencies execute with the local user's
permissions. M4B does not claim defense against a malicious same-UID module or
filesystem actor.

## 8. Vector physical model

### 8.1 Partition

One non-sensitive derived directory is keyed by a versioned one-way digest of:

- principal ID;
- exact scope type;
- exact scope ID;
- data-root namespace.

The clear principal/scope values remain only in canonical SQLite checkpoint
metadata. Recall cannot supply a physical path.

### 8.2 Active generation

The vector database contains only:

- vector schema version;
- embedding epoch ID;
- build generation ID;
- revision ID;
- canonical source/content hash;
- projection/tombstone/source frontier hashes;
- 384 float vector bytes.

It excludes memory text, query text, evidence bodies, approvals, ACLs,
sensitivity labels, receipts, and deletion bodies. Sources labeled
`sensitive` or `secret` are excluded from projection membership. They remain
available, when authorized, through the accepted vector-free reader.

### 8.3 Logical digest

The logical snapshot sorts records by revision identity and seals normalized:

- epoch and generation;
- revision and source hash;
- frontier hashes;
- exact vector values/representation identity.

File pages, row IDs, insertion order, WAL, and file timestamps do not
participate. Incremental and full rebuild equality is logical, not
byte-for-byte database equality.

## 9. Canonical vector-delivery state

Migration `0013` adds conceptually:

- `embedding_epochs`;
- `vector_projection_scopes`;
- `vector_projection_jobs`;
- `vector_projection_receipts`.

### 9.1 Epoch registry

Stores immutable epoch envelope/hash, lifecycle (`qualified`, `building`,
`active`, `retired`, `rejected`), and content-free evidence references. At most
one epoch is active for a configured vector lane.

### 9.2 Scope checkpoint

Stores principal/exact scope, desired/active epoch, desired/active generation,
canonical source frontier, projection/tombstone frontier, next validity
transition, logical digest, state, last applied job, and failure category.

### 9.3 Delivery job

Stores exact scope, reason, desired epoch/frontier, lease, attempts, next
attempt, and content-free failure metadata. It never contains model input or
rendered memory.

### 9.4 Transaction coupling

When vector evaluation/enablement is active, a canonical mutation:

1. applies authority/lifecycle state;
2. advances canonical and tombstone frontiers;
3. marks the exact-scope vector checkpoint pending;
4. enqueues or coalesces one refresh/invalidation job;
5. commits all canonical and metadata effects together.

Embedding and vector-file IO happen after commit. Failure cannot roll back the
canonical mutation.

When vector is disabled and not under evaluation, ordinary mutation does not
create maintenance work. Enabling evaluation begins with a full current-state
rebuild.

A bounded temporal sweep compares `next_validity_transition_at` with the
current time. When a source becomes valid or expires, the sweep marks the
scope pending and enqueues replacement. Until a new generation publishes,
recall reports typed stale degradation rather than a clean miss.

## 10. Projection lifecycle

### 10.1 Exact-scope build

For each claimed scope:

1. record the starting canonical/source/tombstone frontiers;
2. list canonically eligible, non-sensitive exact-scope sources;
3. build passage input with the fixed prefix and bounded truncation;
4. embed in bounded batches;
5. write a new quarantine generation;
6. compute its logical digest and eligible-revision set hash;
7. reread the canonical frontiers and source-set digest;
8. publish only on exact equality;
9. record a content-free receipt;
10. remove the old generation and sidecars after publication.

If canonical state changes during the build, discard quarantine and coalesce a
new job.

### 10.2 Full rebuild

Full rebuild enumerates current governed scopes, builds every scope into a new
epoch/generation namespace, verifies each checkpoint, seals a global manifest,
and publishes only the complete verified set. Partial global rebuild is not an
active epoch.

### 10.3 Correction and exclusion

Canonical eligibility changes immediately. A stale vector may remain
physically present until delivery converges, but fresh postvalidation rejects
it on the next recall.

### 10.4 Purge

Purge waits for or supersedes active scope work, removes revision vectors and
all obsolete generations/quarantine/WAL/sidecar/temp paths, verifies absence,
and seals the physical projection receipt. It does not delete the model
snapshot because the model is shared operator material, not memory content.

### 10.5 Restore

Restore derives vector state again from restored canonical state and the
current tombstone frontier. Restored vector files are never trusted. A stale
backup cannot move a checkpoint or active generation behind current deletion
truth.

## 11. Governed recall

### 11.1 Lane request

The kernel determines the effective lane policy by intersecting operator and
request limits. The semantic request includes:

- exact principal/scope;
- canonical as-of time;
- normalized local query text;
- active epoch;
- bounded top-k and deadline;
- expected scope frontier/digest.

No caller controls model, path, epoch, SQL, remote URL, or cross-scope filter.

### 11.2 Candidate response

The vector child returns:

- revision ID;
- cosine distance/rank;
- epoch and generation;
- source/frontier identity;
- bounded-work counts and status.

It returns no authoritative memory body.

### 11.3 Canonical postvalidation

The kernel:

1. batch reads the returned revision IDs;
2. validates principal/exact scope, lifecycle, validity, sensitivity, usage,
   lineage, conflict, tombstone, and current source frontier;
3. drops changed or ineligible rows;
4. materializes content only from canonical SQLite;
5. merges/deduplicates with accepted lanes;
6. invokes unchanged Context filtering and budgeting.

All-invalid stale hits are `DEGRADED_STALE`, not clean `NO_MATCH`.

`semantic_vector` is an L1 memory lane. Existing discriminated unions that
currently treat only `recent_l1` as memory must explicitly admit this lane;
the generic projection branch cannot absorb it merely because it is another
`RecallLane`.

### 11.4 Modes

| Mode | Vector projection | Recall behavior |
| --- | --- | --- |
| disabled | no maintenance required | accepted vector-free result |
| evaluating | maintained for gate only | evaluator may select vector/hybrid arms |
| opt-in enabled after GO | maintained for configured scopes | semantic lane available under operator/request intersection |
| degraded | stale/missing/corrupt/rebuilding/timed out | typed status plus accepted vector-free result |

## 12. Security and privacy

- Exact-scope physical partition prevents cross-scope membership in a shared
  index.
- Excluding `sensitive` and `secret` sources prevents a less-privileged reader
  from inferring same-scope sensitive membership through vector rank, count,
  distance, or latency.
- Query/passage text is local ephemeral IPC and is forbidden from logs,
  errors, receipts, database rows, and filenames.
- Child environment is allowlisted and excludes unrelated secrets.
- Database/model roots are parent-derived, confined, and symlink-checked.
- IPC payload, batch, dimensions, top-k, operation, and timeout are bounded.
- Vector distance is not returned as authorization or task success.
- Purge scans active/quarantine/sidecar/temp/log/receipt/backup-projection
  surfaces for old identities and raw content.
- M4B does not claim secure heap erasure, malicious-native containment, or
  protection from a same-UID attacker.

## 13. Failure semantics

| Condition | Lane status | Required behavior |
| --- | --- | --- |
| disabled | `DISABLED` | exact vector-free output |
| local model missing/hash mismatch | `DEGRADED_MODEL` | no child ready; vector-free output |
| dependency/extension missing | `DEGRADED_UNAVAILABLE` | vector-free startup/output |
| scope file missing/locked/corrupt | `DEGRADED_INDEX` | quarantine/rebuild; vector-free output |
| wrong/stale epoch or frontier | `DEGRADED_STALE` | reject hits; enqueue rebuild |
| build in progress | `DEGRADED_REBUILDING` | vector-free output |
| query timeout/child crash | `DEGRADED_PROCESS` | terminate/quarantine; vector-free output |
| no similar hit from complete current state | `NO_MATCH` | clean vector no-match; base lanes still apply |

Only a complete, current, published generation may produce `NO_MATCH`.

## 14. Evaluation design

### 14.1 Frozen arms

1. `fts_recency`: accepted recent L1 and governed FTS5 behavior.
2. `layered`: accepted G3R layered behavior including SQLite relations.
3. `vector`: only `semantic_vector`, followed by canonical postvalidation and
   the same compiler.
4. `hybrid`: unchanged layered baseline plus `semantic_vector`, followed by
   the same merge, postvalidation, and compiler.

### 14.2 Partition discipline

- Calibration may determine top-k and a distance/fusion threshold.
- The calibration configuration and hash freeze before holdout/transfer open.
- Holdout and transfer are evaluation-only.
- All arms use identical canonical state, readers, as-of time, policies,
  token budgets, and task scoring.

### 14.3 Case success

A positive case passes only when:

- every expected eligible revision reaches Context;
- no ineligible revision reaches Context;
- provenance/explanation is present;
- the task Oracle succeeds;
- Context pollution does not exceed the frozen expectation.

A negative control passes only by exact exclusion or abstention with the
correct reason.

A strict gain requires hybrid to pass the complete case while both
vector-free arms fail it. Candidate count, rank, or latency alone does not
count.

### 14.4 Expected-profile resources

The benchmark reports separately:

- recall and Context p50/p95/p99;
- vector fallback p50/p95/p99;
- cold model/process ready time;
- scope and full rebuild time;
- epoch migration time;
- model and snapshot bytes;
- dependency/install bytes;
- active index, WAL, quarantine, and temp bytes;
- idle and peak RSS delta;
- disk growth per revision and scope.

Resource costs cannot be hidden inside a utility score.

## 15. Decision algorithm

`GO` requires all of:

1. exact dependency tree, frozen install, real model smoke, and high-severity
   audit pass;
2. offline snapshot and process containment pass;
3. zero critical authority, scope, privacy, correction, purge, restore,
   resurrection, epoch, or fallback regression;
4. hybrid solves at least five positive cases;
5. at least four strict gains over both vector-free arms, including one
   holdout and one transfer;
6. zero Context-pollution increase at both budgets;
7. expected-profile recall, Context, and fallback thresholds pass;
8. evidence integrity, reproducibility, full checks, and review pass.

The first failure makes the decision `NO-GO`. There is no partial credit,
threshold tuning after holdout, second candidate, or default enablement.

## 16. Compatibility and rollback

- Existing contract fields remain optional/versioned.
- Default lane policy does not include `semantic_vector`.
- Missing optional dependencies or model files preserve build and startup.
- Migration is additive; rollback disables vector and removes only disposable
  vector files/metadata after evidence capture.
- A GO rollout is opt-in and can be disabled without migrating canonical
  memory.
- A NO-GO keeps FTS5/layered/SQLite relations as the active supported path.

## 17. Verification layers

1. Contract/property tests for schema, epoch, digest, bounds, and compatibility.
2. Storage integration tests for migration, outbox, frontier, mutation,
   restore, and receipts.
3. Deterministic fake-embedder tests for lifecycle, recall, governance, purge,
   recovery, and failure injection.
4. Real pinned model/index tests for offline identity, semantic behavior, and
   resources.
5. Four-arm frozen replay for utility, negative controls, and Context
   pollution.
6. Full repository static/test/build/frozen-install/audit checks.
7. Artifact verifier and independent full-diff/document review.
8. Hash-bound G4B decision with active fallback named.
