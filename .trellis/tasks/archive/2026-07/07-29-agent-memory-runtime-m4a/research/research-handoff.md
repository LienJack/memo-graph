# M4A research handoff: local graph adoption

## 1. Research identity

| Field | Value |
| --- | --- |
| Topic | `memo-graph-m4a-graph-adoption` |
| Run | `RUN20260729-074511-m4a-current-candidate-an-5479fe` |
| Research date | 2026-07-29 |
| Repository | `/Users/lienli/Documents/GitHub/memo-graph` |
| Qualification probe commit | `d948d4775edfac4bca7224f123703bcdcb278fb2` |
| Canonical implementation candidate | `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| Outcome | proceed to one LadybugDB spike; G4A remains undecided |

The research run answers RQ001–RQ008. It does not authorize a production GO.
It authorizes a single, bounded implementation spike whose failure is a valid
and complete G4A NO-GO.

## 2. Executive decision

LadybugDB is the only candidate that passes the dated qualification table and
is worth implementing in M4A. It is embedded, current, permissively licensed,
available to Node through prebuilt native packages, and passed the local
capability probe.

The qualification probe also found a blocking safety risk: the Node wrapper's
native query timeout is not a reliable wall-clock boundary. A synchronous query
continued beyond 30 seconds, and an asynchronous query configured for 10 ms
took about 9.1 seconds to interrupt.

Therefore:

1. implement exactly one LadybugDB adapter spike;
2. run native queries only in an isolated worker;
3. let the host own the wall-clock deadline and terminate/replace a stuck
   worker;
4. fall back deterministically to SQLite after timeout, crash, stale projection
   or unavailable graph;
5. keep the graph lane disabled by default;
6. issue G4A GO only if the frozen structural replay shows material benefit and
   every correctness, recovery and resource gate passes.

## 3. Candidate qualification scorecard

| Candidate | Current maintenance | Local shape | Node fit | License boundary | M4A result |
| --- | --- | --- | --- | --- | --- |
| LadybugDB `0.18.x` | current releases in July 2026 | embedded/in-process | official Node wrapper and prebuilt packages | MIT | qualifies for one spike |
| SurrealDB | current | can embed in Node with local engines | official Node package | BSL 1.1, change date 2030-01-01 | do not select for this spike |
| FalkorDB | current | local server/module | client-driven, not embedded Node | SSPL v1 | do not select for this spike |
| Neo4j Community | current | separate server/JVM | official driver requires running server | GPLv3 Community | do not select for this spike |
| CozoDB | last formal release 2023-12-11 | embedded | Node bindings exist | not decisive | fails current-maintenance gate |

Qualification evidence:

- LadybugDB architecture and license: `W643e4a2d1a21`
- LadybugDB Node API: `W75b2ec6b7a69`
- LadybugDB current release: `W4a500c1002de`
- LadybugDB npm/platform metadata: `Wbfb1ab43a99d`
- SurrealDB embedded Node: `Wa7d9df2c30ef`
- SurrealDB license: `W66e7f9f0d1d2`
- FalkorDB release and license: `W48cade601d98`, `Wc1978830fe77`
- Neo4j local server/driver and license: `W3d4b92ad568a`, `W571ef2d9156d`
- CozoDB release history: `W4a30bf88e54a`
- local qualification report: `Cc18d1ee238cd`

This table is dated. A future M4A replacement or post-G4A reevaluation must
repeat the qualification gate against then-current releases and licenses.

## 4. Existing SQLite baseline

The graph-free baseline is already capable:

- deterministic bounded breadth-first traversal;
- exact principal and scope filtering;
- lifecycle, purge and valid-time filtering;
- start, depth, fanout, work and result limits;
- typed incomplete/degraded telemetry;
- canonical postvalidation against source eligibility and projection frontier.

Evidence:

- traversal implementation: `Cd21a2331957f`
- canonical relation filters: `C677b9c28f2f2`
- bounded-work limits and telemetry: `Ca1f2c3d4b483`
- canonical candidate checks: `Cef54a421bf22`
- source/frontier postvalidation: `C4cf28593630d`

Consequently, “the graph can perform multi-hop traversal” is not a material
benefit. The paired replay must test structural tasks not already satisfied by
the current adjacency lane.

## 5. Structural replay contract to freeze before tuning

The implementation plan must turn the following into immutable fixtures and
expected logical answers before adapter tuning:

1. **Typed explanatory path** — find a bounded path whose relation sequence
   satisfies a declared pattern such as
   `supports → depends_on → applies_to_scenario`, and return the proof path.
2. **Temporal conflict join** — identify two active conflicting revisions that
   share provenance while all nodes and edges are valid at the requested
   `as_of`.
3. **Scenario migration** — connect a concrete conversation revision through
   topic and scenario relations while preserving exact principal/scope and
   evidence lineage.
4. **Shortest valid proof** — select a deterministic shortest governed path
   among multiple valid alternatives and explain its tie-break.
5. **Cycle and budget pressure** — terminate a cyclic/high-fanout graph with a
   typed incomplete result, never a clean `NO_MATCH`.
6. **Mid-path correction** — after revoke, tombstone or purge of an intermediate
   revision/relation, prevent every stale downstream proof from reappearing.

For every case, both SQLite-only and graph-assisted runs must share:

- the same canonical SQLite ledger snapshot;
- the same principal, exact scope, `as_of` and projection frontier;
- the same starts/depth/fanout/work/result limits;
- the same expected revision IDs and proof-path semantics;
- the same policy, correction, purge and evidence-path Oracle;
- the same timing and resource measurement procedure.

The plan must predeclare a material-gain threshold. It must measure solved
structural tasks and explainability, not merely candidate count or top-k.

## 6. Authority and data-flow contract

```text
SQLite canonical ledger
  → SQLite scope/lifecycle/frontier prefilter
  → projection outbox + epoch/checkpoint
  → disposable GraphStore
  → candidate revision IDs + path evidence
  → SQLite canonical re-read and postvalidation
  → governed recall result or typed fallback
```

Hard boundaries:

- SQLite owns identity, authorization, scope, lifecycle, evidence, tombstones,
  deletion receipts and projection frontier.
- GraphStore stores only rebuildable L2/L3 derived state.
- GraphStore may return revision IDs and path metadata, never authoritative
  memory content or authorization decisions.
- A graph result is unusable until SQLite postvalidation succeeds.
- A partial or interrupted graph traversal cannot return clean `NO_MATCH`.
- Any stale epoch, failed checkpoint, missing graph, query timeout, worker crash
  or rebuild state falls back to SQLite.
- The graph lane stays disabled by default through G4A and release review.

Evidence:

- optional graph design boundary: `Cbec2b2275000`
- projection outbox: `Cfbfff30e4275`
- descendant invalidation: `C0cf67138359a`
- projection frontier schema: `Cb6e60db310d8`
- recall postvalidation: `Cef54a421bf22`, `C4cf28593630d`

## 7. Candidate probe results

The checked-in probe and report are:

- [`ladybug-probe.cjs`](./ladybug-probe.cjs)
- [`local-candidate-probe.md`](./local-candidate-probe.md)

The Darwin arm64 / Node 24 probe passed:

- schema creation;
- bounded `1..3` traversal;
- exact-scope exclusion;
- relation deletion and downstream reachability removal;
- transaction rollback;
- close/reopen;
- export/import;
- logical rebuild equality.

The source database and imported database had different byte sizes and physical
SHA-256 values even though their ordered logical node and edge snapshots were
identical. G4A must therefore compare a canonical logical digest, not physical
database bytes.

Probe evidence:

- capability and recovery implementation: `C4cb66f9610d3`
- measured results and logical digest rule: `C34ae95d42535`
- local resource footprint: `C88e0c9512858`
- timeout containment counterexample: `C34193eec33bb`
- official persistence and migration: `Wc4a44b36abb1`, `We983f0c9c2d6`

## 8. Required spike architecture

The implementation plan should create the smallest replaceable boundary:

1. a backend-neutral `GraphStore` port;
2. a LadybugDB implementation behind an optional dependency boundary;
3. an isolated native-query worker using asynchronous APIs only;
4. a host deadline that terminates and replaces an overdue worker;
5. a projection consumer driven by SQLite outbox and epoch/checkpoint state;
6. canonical logical snapshot/digest and deterministic full rebuild;
7. prefilter and postvalidation adapters that never delegate authority;
8. typed timeout/crash/stale/rebuilding/unavailable reasons;
9. deterministic SQLite fallback;
10. a frozen paired replay and resource harness;
11. a hash-bound G4A decision manifest.

The spike must not:

- enable graph recall by default;
- make LadybugDB a hard install/runtime requirement for SQLite-only users;
- reuse GraphStore for vector recall;
- begin M4B, M5 or M6 work;
- add a new Product Contract requirement namespace;
- claim Linux/Windows as physically verified;
- treat a native timeout request as proof of wall-clock termination.

## 9. Immediate stop and NO-GO conditions

Stop the spike and issue G4A NO-GO if any of the following is observed:

- a graph result bypasses SQLite canonical postvalidation;
- exact principal/scope, lifecycle, valid-time, evidence or frontier parity
  cannot be maintained;
- timeout or worker crash cannot be contained within the predeclared host
  deadline and recovery envelope;
- an interrupted traversal is reported as clean `NO_MATCH`;
- correction, revoke, tombstone or purge permits stale path resurrection;
- full rebuild cannot reproduce the canonical logical digest;
- graph outage prevents valid SQLite-only recall;
- the optional dependency becomes mandatory for the base package;
- the paired replay does not cross the frozen material-gain threshold;
- p95 latency, disk, memory, startup or operator burden exceeds the frozen M0
  envelope;
- licensing or package provenance changes invalidate the qualification record.

NO-GO is a complete M4A outcome. It preserves SQLite adjacency as the supported
runtime and does not affect the independent M4B vector gate.

## 10. Evidence manifest required for final G4A

The final decision must bind hashes for:

- Product Contract and M4A requirements;
- Trellis PRD, design and implementation checklist;
- chosen package version and lockfile;
- native binary identity and platform;
- GraphStore protocol and Ladybug adapter;
- projection schema and migration, if any;
- frozen structural fixture corpus;
- SQLite-only and graph-assisted replay reports;
- governance/correction/purge/failure-injection reports;
- logical rebuild digest report;
- resource benchmark report;
- full test report;
- code review;
- final GO or NO-GO document.

The decision document must distinguish:

- **qualification evidence** — candidate can be tested;
- **implementation evidence** — adapter behaves as designed;
- **paired evaluation evidence** — graph adds material structural value;
- **release evidence** — default and packaging behavior are safe;
- **decision** — GO or NO-GO.

## 11. RQ and Claim/Evidence closure

| RQ | Answer | Core evidence |
| --- | --- | --- |
| RQ001 | one LadybugDB spike, no adoption GO yet | `Cc18d1ee238cd`, `C34193eec33bb`, `C82fddf777118` |
| RQ002 | LadybugDB uniquely qualifies for this spike | candidate web evidence plus `Cc18d1ee238cd` |
| RQ003 | SQLite already covers basic governed BFS; freeze structural gap | `Cd21a2331957f`, `C677b9c28f2f2`, `Ca1f2c3d4b483` |
| RQ004 | graph is a disposable ID/path projection under SQLite authority | `Cbec2b2275000`, `Cef54a421bf22`, `C4cf28593630d` |
| RQ005 | bounded paths are viable; native timeout is not the safety boundary | `W7933dbdb6916`, `C34193eec33bb` |
| RQ006 | logical rebuild works in probe; no-resurrection remains a spike gate | `C4cb66f9610d3`, `C34ae95d42535`, `C0cf67138359a` |
| RQ007 | Darwin arm64 works; other declared platforms remain unverified | `C88e0c9512858`, `W0236fae8d301` |
| RQ008 | gate ordering and symmetric GO/NO-GO are frozen | `C5cf01443db02`, `C82fddf777118`, `C3d2aa11677c8` |

All 15 recorded Claims are supported. The research run is closed because the
remaining uncertainty is implementation evidence that document search cannot
resolve.

## 12. Handoff to `ce-plan`

`ce-plan` must now:

1. freeze package version, optional-dependency shape and platform scope;
2. freeze structural fixtures and material-gain thresholds before tuning;
3. define worker protocol, host deadline and restart/fallback budgets;
4. define GraphStore operations and typed result/reason taxonomy;
5. map every correction/recovery/backup/rebuild path to an executable Oracle;
6. define benchmark dimensions and M0 envelope references;
7. split implementation into logical tasks that each end in a scoped commit;
8. preserve default-off behavior and symmetric GO/NO-GO completion.

No additional candidate search is needed unless LadybugDB fails qualification
before implementation begins. A qualification failure should produce early
NO-GO, not silently widen the spike to another backend.
