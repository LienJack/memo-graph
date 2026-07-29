# Agent Memory Runtime M4A — Technical Design

## 1. Objective

M4A decides whether one pinned LadybugDB projection provides material
structural recall value beyond the accepted G3R SQLite adjacency baseline.

The design has two equally valid terminal paths:

- **GO:** keep an opt-in `relation_graph` lane on the explicitly tested
  platform while SQLite remains authoritative and the default remains
  graph-disabled.
- **NO-GO:** keep SQLite adjacency as the supported L2/L3 structural runtime
  and preserve the graph evidence as a completed adoption experiment.

## 2. Authority and traceability

1. Product Contract R8, R12, R14, R19, and R20 remain the only product
   requirement identifiers.
2. `prd.md` owns scoped M4A acceptance.
3. `research/research-handoff.md` owns candidate qualification and external
   Claim/Evidence.
4. This document owns component, process, persistence, state, query, and
   failure boundaries.
5. `implement.md` owns unit order, test-first work, focused verification,
   commits, and stop points.
6. `docs/plans/2026-07-29-003-feat-local-graph-adoption-plan.md` is the unified
   ce-plan execution view.
7. G4A decision artifacts own the final tested identity and GO/NO-GO result.

## 3. Frozen evaluation constants

These values are fixed before implementation:

| Item | Frozen value |
| --- | --- |
| Accepted baseline commit | `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| Candidate package | `@ladybugdb/core@0.18.3` |
| Qualified environment | Node `24.18.0`, Darwin arm64 |
| Structural cases | 6 |
| Partitions | 2 calibration, 2 holdout, 2 transfer |
| Material gain | >=3 strict case gains, including >=1 holdout and >=1 transfer |
| Critical regression tolerance | 0 |
| Host graph deadline | 75 ms |
| Fallback p95 | <=100 ms |
| Governed recall p50/p95 | <=50/200 ms |
| Replacement ready | <=2 seconds |
| Expected rebuild | <=60 seconds |
| Graph DB + WAL | <=512 MiB |
| Install delta | <=64 MiB |
| Idle/peak RSS delta | <=128/512 MiB |

A case passes only when the governed revision set, ordered proof path, evidence
lineage, completeness, and abstention all match.

A strict case improvement means C passes every one of those assertions while
both A and B fail at least one under the same task semantics and limits.
Candidate count, alternate ordering, or latency alone does not count.

## 4. Component boundaries

### 4.1 Contracts

`@memo-graph/contracts` owns:

- backend and native identity;
- minimal graph node and edge envelopes;
- exact-scope graph snapshot and canonical logical digest;
- graph query bounds and ordered path evidence;
- graph process health and typed failure categories;
- graph scope checkpoint and delivery receipt;
- `relation_graph` lane and graph bounded-work telemetry;
- G4A case, partition, arm, measurement, and decision evidence schemas.

Contracts contain no LadybugDB API types.

### 4.2 SQLite storage

`@memo-graph/storage-sqlite` remains the only persistence authority and owns:

- additive graph-delivery queue and leases;
- per-principal/exact-scope graph checkpoint;
- backend identity and logical digest recorded at the checkpoint;
- exact-scope canonical graph snapshot reads;
- claim/apply/fail/reset/rebuild/health operations;
- transaction coupling between canonical projection change and graph pending
  state;
- monotonic frontier validation and content-free failures.

The storage worker runtime-decodes every new request and response. No graph
package imports `better-sqlite3`.

### 4.3 Graph projection package

`@memo-graph/graph-projection` owns:

- backend-neutral `GraphStore` behavior;
- parent process supervision;
- LadybugDB child process and adapter;
- canonical logical digest;
- exact-scope projector;
- full rebuilder and publish sequence;
- governed graph lane retriever;
- graph resource benchmark.

The optional LadybugDB package is dynamically loaded inside the child. The
package's top level must remain importable when the native optional dependency
is absent.

The package depends one-way on contracts and the public SQLite client. The
memory kernel receives a backend-neutral graph retriever port and does not
import the graph package. The MCP server is the composition root that may load
the graph package when explicitly configured. The root build orders
`graph-projection` after storage and before MCP, while a frozen install with
optional dependencies omitted must still build and start the SQLite-only
runtime.

### 4.4 Memory kernel

`@memo-graph/memory-kernel` owns:

- operator/request lane policy intersection;
- canonical SQLite start selection;
- lane ordering and fallback;
- exact result/source/frontier postvalidation;
- telemetry/status classification;
- transfer of path evidence to the pure compiler.

The kernel does not open a graph database or trust a graph candidate.

### 4.5 Context compiler and MCP

The compiler remains pure and:

- rejects graph candidates without canonical revalidation;
- retains ordered proof-path identity and reason evidence;
- treats incomplete graph work as degraded;
- seals graph telemetry into immutable Context and retrieval receipts.

MCP configuration may explicitly permit the graph lane, but its default policy
remains `recent_l1`. Missing graph dependency, child failure, or disabled graph
must not fail SQLite-only startup.

## 5. Process isolation design

### 5.1 Why a process

The qualification probe showed:

- synchronous native work could continue beyond 30 seconds;
- asynchronous 10 ms timeout took about 9.1 seconds to interrupt.

The wrapper timeout is cooperative, not the hard safety boundary. The graph
child therefore runs outside the MCP process and can be killed at the OS
boundary.

The child process is an availability and crash-containment boundary, not a
security sandbox. The pinned native package remains trusted code running with
the local user's filesystem permissions. Minimal environment and content-free
IPC limit accidental exposure but do not protect against a malicious same-UID
native module or same-UID filesystem race. Stronger privilege isolation is an
M6 concern and cannot be inferred from M4A evidence.

### 5.2 Parent lifecycle

The parent:

1. validates graph configuration and expected backend identity;
2. derives and confines one graph database path under the canonical data root;
3. rejects symlink/path escape and launches one child with an allowlisted
   environment;
4. waits for decoded ready/identity evidence;
5. serializes or bounds requests using unique request identities;
6. starts the 75 ms wall-clock deadline for each graph query;
7. accepts exactly one valid matching response;
8. on timeout/protocol/process failure, marks the child quarantined, returns
   typed graph degradation, kills the child, and starts replacement outside
   the request critical path;
9. rate-limits restart attempts and opens a cooldown circuit breaker after
   repeated failures;
10. never blocks SQLite fallback on replacement readiness.

Shutdown first stops new requests, then closes or terminates the child, and
finally closes SQLite.

### 5.3 Child lifecycle

The child:

- dynamically loads and verifies the pinned native package;
- opens exactly one read/write database object per path;
- reports package, storage, platform, architecture, and binary identity;
- runtime-decodes every command;
- uses asynchronous queries and cooperative timeout;
- wraps writes in explicit transactions;
- emits content-free structured failures;
- closes result, connection, and database handles;
- exits on malformed protocol or parent disconnect.

No synchronous user-controlled or structural query is allowed in the child.

### 5.4 Protocol invariants

- Request IDs are unique and bounded.
- Payload bytes, starts, path patterns, depth, result limit, and deadline are
  bounded before child dispatch.
- Query operations come from a closed typed template set. Raw Cypher, graph
  file paths, and arbitrary child environment values are never accepted.
- Unknown command/version/field is rejected.
- Duplicate, late, mismatched, or post-timeout responses are discarded.
- Diagnostics contain identifiers, counts, versions, hashes, time, and stable
  categories only; they never contain memory text.
- A timeout response cannot be considered clean query completion.

## 6. Graph logical model

### 6.1 Node

A graph node represents a canonical revision or versioned projection identity
needed for structural traversal. It includes:

- graph projection identity;
- owning SQLite revision/projection revision;
- principal and exact scope;
- abstraction and projection type;
- lifecycle marker;
- valid-time interval;
- ledger, tombstone, and projection epochs;
- content/payload hash;
- transform identity;
- evidence or lower-level lineage identifiers.

It excludes memory content, rendered projection text, approval, ACL, receipt,
and evidence body.

### 6.2 Edge

An edge represents one versioned relation revision and includes:

- relation and relation revision identities;
- source and target revision identities;
- relation type and direction;
- principal and exact scope;
- valid-time interval;
- projection/tombstone epochs;
- projection revision, hashes, and lineage pointers.

### 6.3 Snapshot and digest

The canonical logical snapshot sorts:

1. nodes by exact scope, abstraction, projection/revision identity;
2. edges by exact scope, relation type, relation and revision identity.

The digest seals the normalized ordered envelopes, not physical file bytes,
row IDs, page layout, WAL, or insertion order.

## 7. SQLite graph-delivery state

Migration `0012` adds conceptually:

```text
graph_projection_scope_state
  backend
  principal_id
  scope_kind
  scope_id
  status
  source projection frontier
  graph projection epoch
  logical digest
  backend/native identity
  updated_at
  content-free error category

graph_projection_outbox
  stable job identity
  backend
  principal_id
  exact scope
  target projection frontier
  kind
  status/attempts/lease
  timestamps
  content-free failure category

graph_projection_receipts
  job/request identity
  old/new frontier
  logical digest
  backend/native identity
  counts/duration/status
```

Exact column and index names may adapt during implementation, but these
responsibilities cannot be combined with canonical identity or lifecycle
ownership.

### 7.1 Enqueue

Canonical projection apply/invalidation:

1. opens the existing guarded SQLite transaction;
2. marks only the affected graph scope pending;
3. enqueues a stable scope-delivery job;
4. commits canonical state and graph pending evidence together.

The graph write is never inside the canonical transaction.

### 7.2 Apply

The projector:

1. claims one scope job;
2. reads the exact-scope canonical snapshot and frontier;
3. verifies the job target still matches;
4. sends scope replacement to the graph child;
5. reads the graph scope logical snapshot;
6. compares it with SQLite's expected logical digest;
7. in one short SQLite transaction, advances the scope checkpoint and records
   the receipt only if frontier and job lease still match.

Late or stale work is discarded and cannot publish readiness.

### 7.3 Failure

Failure increments retry evidence and leaves scope pending/unavailable.
Retry is bounded and idempotent. Reads use SQLite fallback until a verified
checkpoint exists.

## 8. Projection and rebuild

### 8.1 Scope replacement

Scope replacement is the initial incremental unit:

1. begin graph transaction;
2. delete graph edges and nodes owned by the exact scope;
3. insert the current minimal canonical snapshot;
4. commit;
5. compute and compare the scope logical digest.

Because exact scope is part of every identity, replacing one scope cannot
alter another.

### 8.2 Full rebuild

Full rebuild:

1. marks graph plane/scopes rebuilding in SQLite;
2. creates a fresh graph path;
3. enumerates canonical scopes in stable order;
4. writes each exact-scope snapshot;
5. compares every scope digest and the global logical digest;
6. closes and reopens the new store;
7. repeats digest verification;
8. atomically publishes the new graph path/identity;
9. marks coherent scopes ready;
10. quarantines or removes the previous store only after publish evidence is
    durable.

Any failure keeps SQLite fallback active and the previous graph excluded.

### 8.3 Backup and restore

Backup includes canonical SQLite backup plus graph logical export or a closed
graph copy. Restore does not trust the graph backup:

1. restore and verify SQLite first;
2. mark graph rebuilding/unavailable;
3. inspect graph backup only as derived evidence;
4. rebuild or import to a fresh path;
5. compare canonical logical digest against restored SQLite;
6. publish only after equality.

## 9. Governed graph query

### 9.1 Prefilter

Before graph dispatch, SQLite selects:

- principal and exact scope;
- `as_of`;
- permitted lifecycle and sensitivity;
- live projection frontier;
- approved start revision identities;
- a canonical bounded relation slice containing permitted relation revision
  IDs and exact start/fanout/work counts;
- permitted relation types;
- operator-owned starts, depth, fanout/path, result, and time limits.

Requests may only narrow the operator policy.

The same canonical slice feeds an evaluation-only deterministic graph-free
reference evaluator. It implements the same typed/shortest-path semantics,
tie-breaks, and limits as the graph arm. It is not a production recall lane;
it exists so G4A measures backend contribution rather than comparing a new
algorithm with an arm from which that algorithm was withheld.

### 9.2 Traversal

The graph query:

- uses an explicit upper depth;
- uses the frozen relation pattern or shortest-path mode;
- can traverse only relation revision IDs in the SQLite-generated allowlist;
- uses a closed parameterized query template rather than caller query text;
- limits returned paths with one extra row for truncation detection;
- records query identity, elapsed time, returned depth and counts;
- treats timeout, result+1, unknown backend work, or process failure as
  incomplete.

Graph DB execution details are never used as authorization evidence.

### 9.3 Postvalidation

For every returned path, SQLite:

- checks every node/revision identity;
- checks every relation revision and direction;
- checks principal and exact scope;
- checks lifecycle, validity, sensitivity, usage rules, tombstone, purge, and
  invalidation;
- checks evidence/lower-layer lineage;
- checks graph scope checkpoint against the current projection frontier;
- verifies the path corresponds to the requested typed relation pattern.

One failed element excludes the complete path. A storage or batch limit
degrades the graph lane and preserves SQLite fallback.

### 9.4 Compiler behavior

Only postvalidated paths can influence Context. Graph proof evidence is
bounded and ID/hash-only. Governing constraints, conflicts, and lower-level
evidence retain existing compiler precedence.

## 10. Evaluation design

### 10.1 Structural cases

| Case family | Required behavior |
| --- | --- |
| Typed explanatory path | exact declared relation sequence and proof |
| Temporal conflict | active conflict pair with shared provenance at `as_of` |
| Scenario migration | conversation-to-topic-to-scenario governed path |
| Shortest proof | deterministic shortest valid path and tie-break evidence |
| Cycle/fanout pressure | bounded termination and typed incompleteness |
| Mid-path correction | no stale path after lifecycle/deletion change |

### 10.2 Arms

- **A:** accepted G3R commit and SQLite relation lane.
- **B:** M4A candidate with graph lane disabled plus the evaluation-only
  graph-free structural reference over the same governed slice.
- **C:** same M4A candidate with graph lane enabled.

Every arm shares the canonical input snapshot, cases, principal/scope,
frontier, typed/shortest-path task semantics, budget, limits, and scoring.
Mixed identities invalidate comparison.

### 10.3 Gate

`GO` requires:

- at least three strict C improvements over both A and B;
- at least one strict holdout and one strict transfer improvement;
- no case, partition, G3R, or graph-disabled regression;
- zero critical governance/recovery/privacy violation;
- all physical Expected resource thresholds;
- full verification and no unresolved P0/P1 review finding;
- one hash-valid evidence manifest.

Otherwise M4A records `NO-GO`.

## 11. Failure behavior

| Failure | Graph outcome | SQLite/lower lanes | Clean `NO_MATCH` allowed? |
| --- | --- | --- | --- |
| Graph disabled by policy/request | disabled | continue | only from complete active lanes |
| Optional dependency missing | unavailable | continue | no |
| Child startup/identity mismatch | unavailable | continue | no |
| Scope pending/stale/rebuilding | stale/degraded | continue | no |
| Starts/depth/path/result limit | degraded with exact counts | continue | no |
| Native cooperative timeout | degraded | continue | no |
| Parent 75 ms deadline | kill/quarantine child | continue immediately | no |
| Child exits or protocol malformed | unavailable; restart | continue | no |
| Graph locked/corrupt | unavailable; rebuild | continue | no |
| SQLite postvalidation exclusion | exclude whole path | continue | only if graph work was complete |
| SQLite postvalidation unavailable/limited | degraded | continue | no |
| Correction/revoke/tombstone/purge | scope pending; old graph excluded | continue | no until coherent |
| Scope replacement digest mismatch | job failed; scope not ready | continue | no |
| Full rebuild digest mismatch | rebuild not published | continue | no |
| Expected evidence missing | G4A NO-GO | SQLite accepted | not applicable |

## 12. Migration, rollout, and rollback

### Forward

1. Apply additive migration `0012`.
2. Existing graph scopes are absent/disabled.
3. SQLite-only runtime opens and serves normally.
4. Explicit graph configuration starts the child and marks scopes pending.
5. Projection/rebuild establishes exact verified checkpoints.
6. G4A evaluation runs while default policy remains graph-disabled.
7. A GO permits opt-in use only; it does not change the default.

### Rollback

- Disable graph lane and stop the child.
- Keep additive tables inert or retain them for audit.
- Delete/quarantine graph files without touching canonical SQLite.
- Retry or rebuild only when explicitly requested.
- Restore accepted G3R behavior through existing `relation_sqlite` and
  `recent_l1` lanes.
- Do not down-migrate or rewrite issued Context/receipt artifacts.

## 13. Verification design

Focused Oracles:

1. native sync/adversarial work cannot block the MCP parent;
2. 75 ms host timeout returns typed fallback by p95 100 ms;
3. child kill during query/write cannot corrupt SQLite or publish graph ready;
4. exact package/native identity is bound to health and reports;
5. one-scope apply cannot change another scope;
6. duplicate/stale jobs are idempotent and cannot publish;
7. incremental scope replacement equals clean full rebuild logically;
8. physical graph hash may differ without invalidating logical equality;
9. graph results never bypass exact canonical postvalidation;
10. incomplete graph work cannot return clean no-match;
11. correction, usage block, revoke, tombstone, and purge suppress next read;
12. prohibited plaintext is absent from graph/WAL/export/backup/IPC/logs;
13. outage, lock, corruption, restore, and rebuild retain SQLite operation;
14. graph-disabled behavior equals accepted G3R;
15. frozen holdout/transfer identities cannot be read by tuning code;
16. material gain and Expected resource gates are reproducible;
17. full repository and dependency gates remain green.

## 14. Explicit non-goals

- No second graph candidate.
- No vector or learning work.
- No graph-owned content or authority.
- No default graph enablement.
- No in-process native user query.
- No platform claim beyond measured Darwin arm64 evidence.
- No physical-byte rebuild equality requirement.
- No product-capacity claim from synthetic local benchmarks.
- No rewriting accepted G3R artifacts or historical decisions.
